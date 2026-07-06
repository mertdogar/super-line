// Rewrites the typedoc-generated reference/index.md with a curated front door.
// typedoc only extracts 8 packages (transport-*/store-* extraction produces
// README dumps — see memory/typedoc quirk), so those link to their guides
// instead of silently missing from the list.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const api = (pkg, blurb) => `- [\`@super-line/${pkg}\`](@super-line/${pkg}/index.md) — ${blurb}`
const guide = (pkg, page, blurb) => `- [\`@super-line/${pkg}\`](/guide/${page}) — ${blurb} *(guide)*`

const content = `---
lastUpdated: false
---

# API Reference

Start with [\`@super-line/core\`](@super-line/core/index.md) — the contract is the single
source of truth; everything else implements or consumes it. Packages marked *(guide)*
are documented as hands-on guides rather than extracted API pages.

## Core

${api('core', '`defineContract`, wire types, `SuperLineError`, transport & store interfaces')}
${api('server', '`createSuperLineServer` — implements the contract, owns rooms/topics/auth, cluster bus, `ServerStore`')}
${api('client', '`createSuperLineClient` — calls the contract with full inference, reconnection, stores')}
${api('react', '`createSuperLineHooks` — typed hooks over the client (requests, events, `useResource`)')}

## Transports — the client ↔ server wire

${guide('transport-websocket', 'transport-websocket', 'WebSocket wire, the default')}
${guide('transport-http', 'transport-http', 'HTTP wire — SSE stream or long-poll')}
${guide('transport-libp2p', 'transport-libp2p', 'libp2p wire — WebRTC, NAT traversal, bring-your-own node')}
${guide('transport-loopback', 'transport-loopback', 'in-memory wire for tests')}

## Stores — durable & synced state

${guide('store-memory', 'store', 'plain LWW in-memory store, the default')}
${guide('store-sync', 'synced-state', 'CRDT (Yjs) synced store engine')}
${guide('store-sqlite', 'store', 'durable LWW on better-sqlite3')}
${guide('store-pglite', 'choosing-a-store', 'LWW over Postgres + Electric — no adapter needed')}
${guide('store-sync-pglite', 'store-sync-pglite', 'CRDT over Postgres + Electric — no adapter needed')}

Not sure which store fits? [Choosing a store](/guide/choosing-a-store).

## Adapters — server ↔ server fan-out

${api('adapter-redis', 'Redis pub/sub backbone')}
${api('adapter-libp2p', 'broker-less gossipsub backbone')}
${api('adapter-zeromq', 'ZeroMQ backbone')}
${api('adapter-rabbitmq', 'RabbitMQ backbone')}

## Tooling

${guide('control-center', 'control-center', 'debug webapp — topology, live traffic, presence (`npx @super-line/control-center`)')}
`

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'index.md')
writeFileSync(out, content)
console.log(`reference-index: wrote ${out}`)
