import os from 'node:os'
import { createClient } from '@super-line/client'
import { cluster } from './contract.js'

// A watcher client. It connects through Caddy (round-robin onto some node) and subscribes to
// the `total` snapshot — proof that a server-side aggregate built from the bus reaches clients
// on any node.
const URL = process.env.GATEWAY_URL ?? 'ws://localhost:8080'
const ME = process.env.CLIENT_ID ?? os.hostname()

const client = createClient(cluster, { url: URL, role: 'watcher' })
await client.subscribe('total', (t) => console.log(`${ME} ← cluster total ${t.total}`, t.perNode)).ready
console.log(`${ME} watching the cluster total via ${URL}`)
