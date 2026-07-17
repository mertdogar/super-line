// The bot runtime (PLAN-chat-mastra + PLAN-chat-resources): provisionChatBot mints the identity,
// mastraEngine streams the whole delegation tree into ONE message, onChatMessage runs the channel
// loop — and the bot's own connection carries plugin-chat's resource tools, so the supervisor
// reads the channel's canvas/doc and the editor subagent writes them, server-authorized like any
// member. This process is also the server's, so it seeds every channel with one canvas + one doc
// through the kit (server-initiated: no membership needed, no card in the feed).

import { eq } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'
import { chatAgentTools } from '@super-line/plugin-chat/ai'
import { mastraEngine } from '@super-line/plugin-chat/mastra'
import type { ChatTurnMessage } from '@super-line/plugin-chat/mastra'
import { provisionChatBot } from '@super-line/plugin-chat/server'
import type { auth } from '@super-line/plugin-auth/server'
import type { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import type { Tool } from 'ai'
import { worker, makeAgents, RESOURCE_SHAPES, MODEL } from './agents.js'
import { app } from './contract.js'

type AuthKit = ReturnType<typeof auth<typeof app>>
type ChatKit = ReturnType<typeof chatKitFactory<typeof app>>

export const AGENT_CHANNEL = 'agents'
const KINDS = ['canvas', 'doc'] as const

export async function startSupervisor(deps: { authKit: AuthKit; chatKit: ChatKit; url: string }): Promise<void> {
  const { authKit, chatKit, url } = deps
  const found = (await chatKit.channels.find({ filter: eq('name', AGENT_CHANNEL) }))[0]
  const channel = found ?? (await chatKit.channels.create({ name: AGENT_CHANNEL }))

  const { user, apiKey } = await provisionChatBot(authKit, chatKit, {
    name: 'Supervisor',
    keyLabel: 'supervisor-runtime',
    channels: [channel.id],
  })
  const client = createSuperLineClient(app, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    params: { apiKey },
    crdtCollections: crdtCollectionsClient(), // read_resource opens docs over this connection
  })
  const bot = chatClient(client, { userId: user.id })
  await bot.ready

  // Seed every channel (existing and future — the directory store is live) with one canvas + one
  // doc. Owned kinds mint a fresh doc per create, so idempotence is the kind-check, not the pk.
  const seeded = new Set<string>()
  const ensureResources = async (channelId: string): Promise<void> => {
    if (seeded.has(channelId)) return
    seeded.add(channelId)
    try {
      const existing = await chatKit.resources.of(channelId)
      for (const kind of KINDS) {
        if (!existing.some((r) => r.kind === kind))
          await chatKit.resources.create({ channelId, kind, title: kind === 'canvas' ? 'Canvas' : 'Doc' })
      }
    } catch (err) {
      seeded.delete(channelId) // retry on the next directory tick
      console.error('resource seeding failed', channelId, err)
    }
  }
  const dir = bot.channels()
  const seedAll = (): void => {
    for (const ch of dir.rows()) void ensureResources(ch.id)
  }
  dir.subscribe(seedAll)
  seedAll()

  // The editor's doc-touching tools announce presence (the 🤖 avatar in the pane header while it
  // works); the turn's finally closes whatever it touched.
  const tools = chatAgentTools(client, { resourceShapes: RESOURCE_SHAPES })
  const touched = new Map<string, { kind: string; docId: string }[]>() // per channel — turns run concurrently across channels
  const announcing = (name: 'read_resource' | 'write_resource'): Tool => {
    const base = tools[name]! as Tool & { execute: (input: unknown, o: unknown) => Promise<unknown> }
    return {
      ...base,
      execute: async (input: unknown, o: unknown) => {
        const { channelId, kind, docId } = input as { channelId: string; kind: string; docId: string }
        touched.set(channelId, [...(touched.get(channelId) ?? []), { kind, docId }])
        void bot.announceResource(kind, docId, 'open').catch(() => {})
        return base.execute(input, o)
      },
    } as Tool
  }
  const closeTouched = (channelId: string): void => {
    for (const { kind, docId } of touched.get(channelId) ?? [])
      void bot.announceResource(kind, docId, 'close').catch(() => {})
    touched.delete(channelId)
  }

  const { supervisor, editor } = makeAgents({
    read: { list_resources: tools.list_resources!, read_resource: tools.read_resource! },
    edit: {
      list_resources: tools.list_resources!,
      read_resource: announcing('read_resource'),
      write_resource: announcing('write_resource'),
    },
  })
  // The resource tools take an explicit channelId, but "the canvas" means THIS channel — so brief
  // the agent on the channel it's answering in and its resources' docIds (onChatMessage hands us
  // the channelId for exactly this). Without it the model has to guess the channelId and fails.
  const brief = async (channelId: string): Promise<ChatTurnMessage> => {
    const resources = await chatKit.resources.of(channelId)
    const lines = resources.map((r) => `  • ${r.kind}: docId "${r.docId}" (title "${r.title}")`)
    return {
      role: 'user',
      content:
        `[context — not from the user] You are answering in chat channel "${channelId}". ` +
        `Pass this exact channelId to every resource tool. This channel's shared resources:\n${lines.join('\n')}\n` +
        `To edit the canvas or doc, delegate to the editor with the kind + docId; it does not need to list first.`,
    }
  }
  const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }, { agent: editor }] })
  onChatMessage(bot, async ({ channelId, history }) => {
    if (!process.env.AI_GATEWAY_API_KEY) {
      await bot.send(channelId, 'Set AI_GATEWAY_API_KEY in .env to bring the supervisor online.')
      return
    }
    try {
      await engine.respond(bot, channelId, [await brief(channelId), ...history])
    } finally {
      closeTouched(channelId)
    }
  })

  console.log(`  🤖 Supervisor online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : 'no AI_GATEWAY_API_KEY'})`)
  void client // owned for the process lifetime
}
