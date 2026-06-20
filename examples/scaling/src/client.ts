import os from 'node:os'
import { createClient } from '@super-line/client'
import { sync } from './contract.js'

// One of six replica clients. Each connects through Caddy (ws://caddy:8080), which
// round-robins the upgrade onto a real node. Because state lives in Redis, it does
// not matter which node we land on — a message we send comes back out to every other
// client on every other node.
const URL = process.env.GATEWAY_URL ?? 'ws://localhost:8080'
// Under `deploy.replicas`, os.hostname() is the container's short id; compose also
// prefixes each log line with the readable container name. Set CLIENT_ID to override.
const ME = process.env.CLIENT_ID ?? os.hostname()
const period = 2000 + Math.floor(Math.random() * 2000) // 2–4s, fixed per replica

const client = createClient(sync, { url: URL, role: 'user' })

client.on('message', (m) => console.log(`${ME} ← message  "${m.text}" (from ${m.from})`))
await client.subscribe('announce', (a) => console.log(`${ME} ← announce "${a.text}"`)).ready

let n = 0
setInterval(() => void client.say({ from: ME, text: `msg #${++n}` }), period)
console.log(`${ME} connected via ${URL} (sending every ${period}ms)`)
