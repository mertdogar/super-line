import { ToolLoopAgent, tool } from 'ai'
import type { ModelMessage } from 'ai'
import { z } from 'zod'
import type { SuperLineClient } from '@super-line/client'
import { eq } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chatClient } from '@super-line/plugin-chat/client'
import type { ChatClient } from '@super-line/plugin-chat/client'
import { chatAgentTools, pipeUIMessageStream } from '@super-line/plugin-chat/ai-sdk'
import type { auth } from '@super-line/plugin-auth/server'
import type { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { chat } from './contract.js'

type AuthKit = ReturnType<typeof auth<typeof chat>>
type ChatKit = ReturnType<typeof chatKitFactory<typeof chat>>

/** The channel the AI agent lives in. Humans are auto-joined so the bot is reachable out of the box. */
export const AGENT_CHANNEL = 'ask-ai'
const BOT_NAME = 'Ask AI'
const RUNTIME_MARKER = 'collections-chat-agent'
// A Vercel AI Gateway model string ("provider/model"). The gateway reaches Anthropic/OpenAI/Google
// behind one API key (AI_GATEWAY_API_KEY), so swapping providers is a one-line change.
const MODEL = process.env.MODEL ?? process.env.AGENT_MODEL ?? 'anthropic/claude-sonnet-5'

/** Ensure the agent's channel exists and everyone is dropped into it. Returns its id. */
export async function seedChannels(chatKit: ChatKit): Promise<string> {
  const found = (await chatKit.channels.find({ filter: eq('name', AGENT_CHANNEL) }))[0]
  const channel = found ?? (await chatKit.channels.create({ name: AGENT_CHANNEL }))
  return channel.id
}

/**
 * Provision the AI agent as a REGULAR user (PLAN-plugin-chat decision 13) and run it as a genuine client:
 *
 *   1. idempotently create a passwordless `Ask AI` user (`authKit.users.create`)
 *   2. mint an API key for it (`authKit.apiKeys.create`) and add it to #ask-ai (`chatKit.members.add`)
 *   3. connect a real super-line client over WS with `?apiKey=` and use the SAME `chatClient` a human uses
 *   4. reply to human messages in #ask-ai — via the Anthropic SDK when `ANTHROPIC_API_KEY` is set, else a
 *      deterministic canned responder so the example runs fully offline
 *
 * The bot's traffic is ordinary wire traffic: it shows up in the Control Center like any other user.
 */
export async function startAgent(deps: { authKit: AuthKit; chatKit: ChatKit; url: string }): Promise<void> {
  const { authKit, chatKit, url } = deps
  const channelId = await seedChannels(chatKit)

  let user = (await authKit.users.find({ filter: eq('displayName', BOT_NAME), includeDeactivated: true })).find(
    (candidate) => candidate.metadata?.runtime === RUNTIME_MARKER,
  )
  if (!user) {
    user = await authKit.users.create({
      displayName: BOT_NAME,
      metadata: { runtime: RUNTIME_MARKER },
    })
  }
  if (user.deletedAt != null) {
    await authKit.users.reactivate(user.id)
    user = { ...user, deletedAt: null }
  }
  for (const key of await authKit.apiKeys.listFor(user.id)) {
    if (key.label === RUNTIME_MARKER) await authKit.apiKeys.revoke(key.id)
  }
  const { key: apiKey } = await authKit.apiKeys.create(user.id, { role: 'user', label: RUNTIME_MARKER })
  await chatKit.members.add(channelId, user.id).catch((error) => {
    if ((error as { code?: string }).code !== 'CONFLICT') throw error
  })

  const client = createSuperLineClient(chat, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    params: { apiKey },
  })
  const agent = chatClient(client, { userId: user.id })
  await agent.ready

  const respond = makeStreamer(client, agent, channelId)
  const feed = agent.messages(channelId)
  await feed.ready
  const handled = new Set(feed.rows().map((message) => message.id))
  let queue: Promise<void> | undefined
  feed.subscribe(() => {
    for (const message of feed.rows()) {
      if (handled.has(message.id) || message.status === 'streaming') continue
      handled.add(message.id)
      if (message.authorId === user.id || typeof message.content !== 'string' || message.metadata?.resource) continue
      const prompt = message.content
      queue = (queue ?? Promise.resolve())
        .then(async () => {
          const page = await agent.history(channelId, { limit: 20 })
          const history = page.messages.flatMap((item): ModelMessage[] => {
            if (typeof item.content !== 'string') return []
            return [{ role: item.authorId === user.id ? 'assistant' : 'user', content: item.content }]
          })
          await respond(prompt, history)
        })
        .catch((error) => console.error('Ask AI turn failed', error))
      void queue
    }
  })

  console.log(`  🤖 Ask AI agent online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : 'offline canned replies'})`)
}

type Streamer = (prompt: string, history: ModelMessage[]) => Promise<void>

/**
 * Build the reply pipeline: the bot answers as a STREAMED message (PLAN-chat-streaming) — reasoning,
 * its tool calls, and text land live in #ask-ai as message parts, exactly what the UI renders.
 *
 * With `AI_GATEWAY_API_KEY`: a `ToolLoopAgent` whose `stream()` result pipes through
 * `pipeUIMessageStream` into a plugin-chat writer — one line bridges the AI SDK to the wire. The agent
 * keeps the read-only toolset over its OWN connection (look around, read channels, list members); the
 * posting is the stream itself, so `send_message`/`join`/`leave` stay omitted. Without a key: a canned
 * responder that still streams word-by-word, so the demo shows live streaming fully offline.
 */
/** A LIVE weather tool (Open-Meteo, keyless) — gives the agent a real external call to stream. */
const weatherTool = tool({
  description: 'Get the current weather for a city: temperature, humidity, wind, and conditions.',
  inputSchema: z.object({ city: z.string().describe('City name, e.g. "Ankara"') }),
  execute: async ({ city }) => {
    const geo = (await (
      await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)
    ).json()) as { results?: { latitude: number; longitude: number; name: string; country?: string }[] }
    const place = geo.results?.[0]
    if (!place) return { error: `no such place: ${city}` }
    const wx = (await (
      await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
          '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code',
      )
    ).json()) as { current?: Record<string, unknown> }
    return { place: `${place.name}${place.country ? `, ${place.country}` : ''}`, ...wx.current }
  },
})

function makeStreamer(
  client: SuperLineClient<typeof chat, 'user'>,
  agentChat: ChatClient<typeof chat>,
  channelId: string,
): Streamer {
  if (!process.env.AI_GATEWAY_API_KEY) return cannedStreamer(agentChat, channelId)
  const { send_message: _send, join_channel: _join, leave_channel: _leave, ...contextTools } = chatAgentTools(client)
  const agent = new ToolLoopAgent({
    model: MODEL,
    instructions:
      'You are "Ask AI", a concise, friendly assistant embedded in a team chat workspace. ' +
      `This conversation happens in the channel #${AGENT_CHANNEL} (channelId: "${channelId}") — use that id with your tools. ` +
      'You may use your tools to look around (list channels, read recent messages, list members), and you have a live ' +
      'weather tool for real-world weather questions — members watch your reasoning and tool calls stream live. ' +
      'Reply in one short paragraph of plain text.',
    tools: { ...contextTools, weather: weatherTool },
    providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } } },
  })
  return async (_prompt, history) => {
    const w = await agentChat.stream(channelId, { metadata: { producer: RUNTIME_MARKER } })
    // the old one-shot path guarded `if (answer.trim())` — the streaming equivalent: a turn that
    // never produced a single part must not leave an empty bubble behind
    let pushed = false
    const sink = {
      push: (...events: Parameters<typeof w.push>) => {
        pushed = true
        w.push(...events)
      },
    }
    try {
      const result = await agent.stream({ messages: history, abortSignal: w.signal })
      // For the finish event the AI SDK splices messageMetadata ONTO the `finish` chunk itself
      // (a standalone `message-metadata` chunk is only emitted for OTHER part types), and 0.6.0
      // offers dropped framing chunks — `finish` included — to mapDataPart: the turn's token
      // usage lands as a durable data part.
      const { error } = await pipeUIMessageStream(
        sink,
        result.toUIMessageStream({
          messageMetadata: ({ part }) => (part.type === 'finish' ? { usage: part.totalUsage } : undefined),
        }),
        {
          mapDataPart: (chunk) => {
            if (chunk.type !== 'finish') return undefined
            const usage = (chunk.messageMetadata as { usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } } | undefined)?.usage
            // presence-based: a provider that reported no usage fields at all emits nothing,
            // while a genuine 0-token turn still gets its row
            if (usage?.totalTokens === undefined && usage?.inputTokens === undefined && usage?.outputTokens === undefined)
              return undefined
            return {
              key: 'usage',
              data: {
                kind: 'usage' as const,
                ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              },
            }
          },
        },
      )
      if (!pushed) {
        // ADR-0014: deleting a still-streaming message SETTLES it first server-side — one call
        // replaces the old abort-then-delete recipe, no consumer ever sees a raw disappearance,
        // and the cancel fanout releases this client's local writer handle moments later
        await agentChat.deleteMessage(w.messageId).catch(() => {})
        return
      }
      // the settle contract (0.5 migration guide §10): a member cancel settles the row
      // server-side — never finalize after it
      if (w.signal.aborted) return
      await w.finalize(error !== undefined ? { status: 'error', error } : {})
    } catch (err) {
      // w.abort is idempotent after a server-side settle (a cancel already settled the row → no-op),
      // so a genuine error still surfaces here instead of being swallowed by a signal check
      await w.abort(String(err)).catch(() => {})
      throw err
    }
  }
}

/** A deterministic offline responder — still a real STREAM (word-by-word) so the demo needs no key. */
function cannedStreamer(agentChat: ChatClient<typeof chat>, channelId: string): Streamer {
  const answer = (prompt: string): string => {
    const p = prompt.toLowerCase()
    if (/\b(hi|hello|hey)\b/.test(p)) return 'Hey there! 👋 I’m the Ask AI bot — set AI_GATEWAY_API_KEY to give me a real brain.'
    if (p.includes('?'))
      return `Good question. I’m running in offline demo mode (no AI_GATEWAY_API_KEY), so I can’t answer “${prompt.slice(0, 80)}” for real — but the wire path is live: this reply is STREAMING from a genuine API-key user over WebSocket.`
    return `Got it: “${prompt.slice(0, 80)}”. I’m in offline demo mode — add AI_GATEWAY_API_KEY to the server to make me actually helpful.`
  }
  return async (prompt) => {
    const w = await agentChat.stream(channelId, { metadata: { producer: RUNTIME_MARKER } })
    try {
      w.push({ type: 'part_start', key: 't', partType: 'text' })
      for (const word of answer(prompt).split(/(?<=\s)/)) {
        if (w.signal.aborted) throw new Error(String(w.signal.reason ?? 'cancelled'))
        w.push({ type: 'delta', key: 't', text: word })
        await new Promise((r) => setTimeout(r, 40)) // typewriter pace, visibly live
      }
      w.push({ type: 'part_end', key: 't' })
      await w.finalize()
    } catch (err) {
      await w.abort(String(err)).catch(() => {})
      throw err
    }
  }
}
