import { ToolLoopAgent, tool } from 'ai'
import { z } from 'zod'
import type { SuperLineClient } from '@super-line/client'
import { eq } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chatClient } from '@super-line/plugin-chat/client'
import type { ChatClient } from '@super-line/plugin-chat/client'
import { chatAgentTools, pipeUIMessageStream } from '@super-line/plugin-chat/ai'
import type { auth } from '@super-line/plugin-auth/server'
import type { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { chat, type Message } from './contract.js'

type AuthKit = ReturnType<typeof auth<typeof chat>>
type ChatKit = ReturnType<typeof chatKitFactory<typeof chat>>

/** The channel the AI agent lives in. Humans are auto-joined so the bot is reachable out of the box. */
export const AGENT_CHANNEL = 'ask-ai'
const BOT_NAME = 'Ask AI'
const BOT_EMAIL = 'ask-ai@collections-chat.local'
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

  // idempotent provisioning: find the bot by its (unique) display name, else create it passwordless
  const existing = (await authKit.users.find({ filter: eq('displayName', BOT_NAME), includeDeactivated: true }))[0]
  const bot = existing ?? (await authKit.users.create({ email: BOT_EMAIL, displayName: BOT_NAME, metadata: { bot: true } }))
  const { key } = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'agent-runtime' })
  await chatKit.members.add(channelId, bot.id).catch(() => {}) // already a member on a restart → fine

  const client = createSuperLineClient(chat, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    params: { apiKey: key },
  })
  const agent = chatClient(client, { userId: bot.id })
  await agent.ready

  const respond = makeStreamer(client, agent, channelId)
  const feed = agent.messages(channelId, { limit: 20 })
  await feed.ready
  const seen = new Set(feed.rows().map((m) => m.id)) // ignore the backlog present at startup

  feed.subscribe(() => {
    for (const m of feed.rows() as Message[]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      if (m.authorId === bot.id) continue // never answer itself
      void handle(m)
    }
  })

  const recentContext = (): { role: 'user' | 'assistant'; text: string }[] =>
    (feed.rows() as Message[])
      .filter((m) => m.status !== 'streaming') // exclude only IN-FLIGHT turns — settled ones stay
      .slice(-8)
      .map((m) => ({
        role: m.authorId === bot.id ? 'assistant' : 'user',
        // a settled turn can be textless (aborted, tool-only) — keep it in history, honestly labeled
        text:
          m.content === undefined
            ? `[${m.status ?? 'message'}${m.error ? `: ${m.error}` : ''} — no text]`
            : typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content),
      }))

  async function handle(m: Message): Promise<void> {
    try {
      await respond(typeof m.content === 'string' ? (m.content ?? '') : JSON.stringify(m.content), recentContext())
    } catch (err) {
      console.error('agent reply failed', err)
    }
  }

  console.log(`  🤖 Ask AI agent online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : 'offline canned replies'})`)
}

type Streamer = (prompt: string, history: { role: 'user' | 'assistant'; text: string }[]) => Promise<void>

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
  })
  return async (_prompt, history) => {
    const w = await agentChat.stream(channelId)
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
      const result = await agent.stream({ messages: history.map((h) => ({ role: h.role, content: h.text })) })
      const { error } = await pipeUIMessageStream(sink, result.toUIMessageStream())
      if (!pushed) {
        await w.abort('empty reply')
        await agentChat.deleteMessage(w.messageId).catch(() => {})
        return
      }
      await w.finalize(error !== undefined ? { status: 'error', error } : {})
    } catch (err) {
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
    const w = await agentChat.stream(channelId)
    try {
      w.push({ type: 'part_start', key: 't', partType: 'text' })
      for (const word of answer(prompt).split(/(?<=\s)/)) {
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
