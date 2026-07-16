import { ToolLoopAgent } from 'ai'
import type { SuperLineClient } from '@super-line/client'
import { eq } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chatClient } from '@super-line/plugin-chat/client'
import { chatAgentTools } from '@super-line/plugin-chat/ai'
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

  const reply = makeResponder(client, channelId)
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
    (feed.rows() as Message[]).slice(-8).map((m) => ({
      role: m.authorId === bot.id ? 'assistant' : 'user',
      text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }))

  async function handle(m: Message): Promise<void> {
    try {
      const answer = await reply(typeof m.content === 'string' ? m.content : JSON.stringify(m.content), recentContext())
      if (answer.trim()) await agent.send(channelId, answer.trim())
    } catch (err) {
      console.error('agent reply failed', err)
    }
  }

  console.log(`  🤖 Ask AI agent online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : 'offline canned replies'})`)
}

type Responder = (prompt: string, history: { role: 'user' | 'assistant'; text: string }[]) => Promise<string>

/**
 * Build the reply function: a `ToolLoopAgent` (Vercel AI SDK via the AI Gateway) when
 * `AI_GATEWAY_API_KEY` is set, otherwise a canned offline responder so the demo runs with no key.
 *
 * The agent gets the plugin's toolset over its OWN connection (`@super-line/plugin-chat/ai`) — so it can
 * look around the workspace (list channels, read other channels it belongs to, see who's in them) while
 * answering. The write tools are spread-omitted: the runtime below owns the actual posting, so the model
 * gathers context and returns plain text. Every tool call is authorization-checked server-side — the
 * model can never see beyond the bot user's own membership.
 */
function makeResponder(client: SuperLineClient<typeof chat, 'user'>, channelId: string): Responder {
  if (!process.env.AI_GATEWAY_API_KEY) return cannedResponder()
  const { send_message: _send, join_channel: _join, leave_channel: _leave, ...contextTools } = chatAgentTools(client)
  const agent = new ToolLoopAgent({
    model: MODEL,
    instructions:
      'You are "Ask AI", a concise, friendly assistant embedded in a team chat workspace. ' +
      `This conversation happens in the channel #${AGENT_CHANNEL} (channelId: "${channelId}") — use that id with your tools. ` +
      'You may use your tools to look around (list channels, read recent messages, list members) when it helps. ' +
      'Reply to the conversation in one short paragraph of plain text — the runtime posts it for you.',
    tools: contextTools,
  })
  return async (_prompt, history) => {
    const { text } = await agent.generate({
      messages: history.map((h) => ({ role: h.role, content: h.text })),
    })
    return text
  }
}

/** A deterministic offline responder so the demo works with no API key. */
function cannedResponder(): Responder {
  return async (prompt) => {
    const p = prompt.toLowerCase()
    if (/\b(hi|hello|hey)\b/.test(p)) return 'Hey there! 👋 I’m the Ask AI bot — set AI_GATEWAY_API_KEY to give me a real brain.'
    if (p.includes('?'))
      return `Good question. I’m running in offline demo mode (no AI_GATEWAY_API_KEY), so I can’t answer “${prompt.slice(0, 80)}” for real — but the wire path is live: this reply came from a genuine API-key user over WebSocket.`
    return `Got it: “${prompt.slice(0, 80)}”. I’m in offline demo mode — add AI_GATEWAY_API_KEY to the server to make me actually helpful.`
  }
}
