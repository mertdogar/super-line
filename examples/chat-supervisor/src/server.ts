// chat-supervisor server: auth + chat plugins on one super-line server, durable sqlite collections
// (streamed turn-trees survive restarts — reload and the cards are still there), and the Supervisor
// bot runtime riding the same WebSocket wire as the browser.

import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { auth } from '@super-line/plugin-auth/server'
import { chat } from '@super-line/plugin-chat/server'
import { app } from './contract.js'
import { startSupervisor, AGENT_CHANNEL } from './runtime.js'

const PORT = Number(process.env.PORT ?? 8792)

const backend = sqliteCollections({ file: './chat-supervisor.db', collections: app.collections })
const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
const chatKit = chat({ contract: app })

const server = http.createServer()
const srv = createSuperLineServer(app, {
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  nodeName: 'chat-supervisor',
  plugins: [authKit.plugin, chatKit.plugin],
  authenticate: authKit.authenticate,
  identify: authKit.identify,
  onConnection: (_conn, ctx) => {
    const { userId } = ctx as { userId?: string }
    if (!userId) return
    // first-timers land in #agents so the demo is one sign-up away from a delegation
    void (async () => {
      if ((await chatKit.members.channelsOf(userId)).length > 0) return
      const ch = (await chatKit.channels.find())[0]
      if (ch) await chatKit.members.add(ch.id, userId).catch(() => {})
    })().catch((err) => console.error('auto-join failed', err))
  },
})
srv.implement({})

server.listen(PORT, async () => {
  console.log(`chat-supervisor server on ws://localhost:${PORT}`)
  await startSupervisor({ authKit, chatKit, url: `ws://localhost:${PORT}` }).catch((err) =>
    console.error('supervisor failed to start', err),
  )
  console.log(`  ask something in #${AGENT_CHANNEL} — e.g. "compare the weather in Ankara and Berlin"`)
})
