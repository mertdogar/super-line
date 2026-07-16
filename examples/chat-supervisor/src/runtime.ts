// The bot runtime: provision the Supervisor as a REGULAR user (API key), watch #agents over the
// same wire a human uses, and answer every human message as ONE streamed message that carries the
// whole delegation tree — supervisor lane at the root, each subagent's lane nested under its
// delegate tool part (`parent`). Reload-durable by construction: parts are rows, checkpointed ~1s.

import { eq } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import type { SuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chatClient } from '@super-line/plugin-chat/client'
import type { ChatClient, ChatStreamHandle } from '@super-line/plugin-chat/client'
import type { auth } from '@super-line/plugin-auth/server'
import type { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { worker, makeDelegateTool, makeSupervisor, MODEL } from './agents.js'
import { createChunkAdapter } from './chunk-adapter.js'
import type { ChunkLike } from './chunk-adapter.js'
import { app, type Message } from './contract.js'

type AuthKit = ReturnType<typeof auth<typeof app>>
type ChatKit = ReturnType<typeof chatKitFactory<typeof app>>

export const AGENT_CHANNEL = 'agents'
const BOT_NAME = 'Supervisor'
const BOT_EMAIL = 'supervisor@chat-supervisor.local'

export async function startSupervisor(deps: { authKit: AuthKit; chatKit: ChatKit; url: string }): Promise<void> {
  const { authKit, chatKit, url } = deps
  const found = (await chatKit.channels.find({ filter: eq('name', AGENT_CHANNEL) }))[0]
  const channel = found ?? (await chatKit.channels.create({ name: AGENT_CHANNEL }))

  const existing = (await authKit.users.find({ filter: eq('displayName', BOT_NAME), includeDeactivated: true }))[0]
  const bot = existing ?? (await authKit.users.create({ email: BOT_EMAIL, displayName: BOT_NAME, metadata: { bot: true } }))
  const { key } = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'supervisor-runtime' })
  await chatKit.members.add(channel.id, bot.id).catch(() => {}) // already a member on a restart

  const client = createSuperLineClient(app, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    params: { apiKey: key },
  })
  const botChat = chatClient(client, { userId: bot.id })
  await botChat.ready

  const feed = botChat.messages(channel.id, { limit: 20 })
  await feed.ready
  const seen = new Set(feed.rows().map((m) => m.id))
  feed.subscribe(() => {
    for (const m of feed.rows() as Message[]) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      if (m.authorId === bot.id) continue
      void answer(m).catch((err) => console.error('supervisor turn failed', err))
    }
  })

  type TurnMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string }
  const history = (): TurnMessage[] =>
    (feed.rows() as Message[])
      .filter((m) => m.status !== 'streaming')
      .slice(-8)
      .map((m): TurnMessage => {
        const content =
          m.content === undefined
            ? `[${m.status ?? 'message'} — no text]`
            : typeof m.content === 'string'
              ? m.content
              : JSON.stringify(m.content)
        return m.authorId === bot.id ? { role: 'assistant', content } : { role: 'user', content }
      })

  async function answer(_m: Message): Promise<void> {
    if (!process.env.AI_GATEWAY_API_KEY) {
      await botChat.send(channel.id, 'Set AI_GATEWAY_API_KEY in .env to bring the supervisor online.')
      return
    }
    const w = await botChat.stream(channel.id)
    try {
      await runTurn(w, history())
      await w.finalize()
    } catch (err) {
      await w.abort(String(err)).catch(() => {})
      throw err
    }
  }

  async function runTurn(w: ChatStreamHandle<typeof app>, messages: TurnMessage[]): Promise<void> {
    // One delegate tool per turn, closed over THIS turn's writer: its execute() streams the
    // worker's whole lane into the same message, nested under the delegate call's tool part.
    const delegate = makeDelegateTool(async (agentType, task, toolCallId) => {
      const anchor = `s:${toolCallId}` // the supervisor lane's stored key for this delegate call
      const wk = createChunkAdapter(new Set(), { prefix: `w:${toolCallId}:`, parent: anchor })
      const stream = await worker.stream(task)
      let report = ''
      for await (const chunk of stream.fullStream as AsyncIterable<ChunkLike>) {
        if (chunk.type === 'text-delta') report += ((chunk.payload as { text?: string })?.text ?? '')
        const events = wk.map(chunk)
        if (events.length > 0) w.push(...events)
      }
      const tail = wk.end()
      if (tail.length > 0) w.push(...tail)
      if (wk.error !== undefined) return { content: wk.error, isError: true }
      return { content: report.trim() || `(${agentType} produced no report)`, isError: false }
    })

    const supervisor = makeSupervisor(delegate)
    const sup = createChunkAdapter(new Set(), { prefix: 's:' })
    const stream = await supervisor.stream(messages)
    for await (const chunk of stream.fullStream as AsyncIterable<ChunkLike>) {
      const events = sup.map(chunk)
      if (events.length > 0) w.push(...events)
    }
    const tail = sup.end()
    if (tail.length > 0) w.push(...tail)
    if (sup.error !== undefined) throw new Error(sup.error)
  }

  console.log(`  🤖 ${BOT_NAME} online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : 'no AI_GATEWAY_API_KEY'})`)
  void client // owned for the process lifetime
}

export type { ChatClient, SuperLineClient }
