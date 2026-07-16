// The bot runtime, now three library calls (PLAN-chat-mastra — this file used to be ~130 lines of
// hand-rolled wiring): provisionChatBot mints the identity, mastraEngine streams the whole
// delegation tree into ONE message (supervisor lane at the root, each worker nested under its
// delegate tool part), and onChatMessage runs the channel loop — every public channel is a
// conversation with the supervisor, turns serialized per channel, reload-durable by construction.

import { eq } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'
import { mastraEngine } from '@super-line/plugin-chat/mastra'
import { provisionChatBot } from '@super-line/plugin-chat/server'
import type { auth } from '@super-line/plugin-auth/server'
import type { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { worker, supervisor, MODEL } from './agents.js'
import { app } from './contract.js'

type AuthKit = ReturnType<typeof auth<typeof app>>
type ChatKit = ReturnType<typeof chatKitFactory<typeof app>>

export const AGENT_CHANNEL = 'agents'

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
  })
  const bot = chatClient(client, { userId: user.id })
  await bot.ready

  const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })
  onChatMessage(bot, async ({ channelId, history }) => {
    if (!process.env.AI_GATEWAY_API_KEY) {
      await bot.send(channelId, 'Set AI_GATEWAY_API_KEY in .env to bring the supervisor online.')
      return
    }
    await engine.respond(bot, channelId, history)
  })

  console.log(`  🤖 Supervisor online in #${AGENT_CHANNEL} (${process.env.AI_GATEWAY_API_KEY ? MODEL : 'no AI_GATEWAY_API_KEY'})`)
  void client // owned for the process lifetime
}
