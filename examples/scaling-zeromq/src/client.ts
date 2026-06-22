import os from 'node:os'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { sync } from './contract.js'

// One of six replica clients. Each connects through Caddy (ws://caddy:8085), which
// round-robins the upgrade onto a real node. The nodes share state over the ZeroMQ
// mesh, so it does not matter which node we land on — a message we send comes back
// out to every other client on every other node.
const URL = process.env.GATEWAY_URL ?? 'ws://localhost:8085'
const ME = process.env.CLIENT_ID ?? os.hostname()
const period = 2000 + Math.floor(Math.random() * 2000) // 2–4s, fixed per replica

const client = createSuperLineClient(sync, { transport: webSocketClientTransport({ url: URL }), role: 'user' })

client.on('message', (m) => console.log(`${ME} ← message  "${m.text}" (from ${m.from})`))
await client.subscribe('announce', (a) => console.log(`${ME} ← announce "${a.text}"`)).ready

let n = 0
setInterval(() => void client.say({ from: ME, text: `msg #${++n}` }), period)
console.log(`${ME} connected via ${URL} (sending every ${period}ms)`)
