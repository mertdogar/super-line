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

${api('core', '`defineContract`, wire types, `SuperLineError`, transport & collection interfaces')}
${api('server', '`createSuperLineServer` — implements the contract, owns rooms/topics/auth, cluster bus, collection co-writers')}
${api('client', '`createSuperLineClient` — calls the contract with full inference, reconnection, collections')}
${api('react', '`createSuperLineHooks` — typed hooks over the client (requests, events, `useCollection`/`useDoc`)')}

## Transports — the client ↔ server wire

${guide('transport-websocket', 'transport-websocket', 'WebSocket wire, the default')}
${guide('transport-http', 'transport-http', 'HTTP wire — SSE stream or long-poll')}
${guide('transport-libp2p', 'transport-libp2p', 'libp2p wire — WebRTC, NAT traversal, bring-your-own node')}
${guide('transport-loopback', 'transport-loopback', 'in-memory wire for tests')}

## Collections — typed, contract-declared persisted state

${guide('collections-memory', 'collections', 'typed LWW rows — in-memory · relay')}
${guide('collections-sqlite', 'collections', 'typed LWW rows — durable (better-sqlite3) · relay')}
${guide('collections-pglite', 'collections', 'typed LWW rows — self-clustering (Postgres + Electric)')}
${guide('collections-crdt-memory', 'collections', 'CRDT documents — in-memory + the universal client engine')}
${guide('collections-crdt-libsql', 'collections', 'CRDT documents — durable (libSQL/Turso) · relay')}
${guide('collections-crdt-pglite', 'collections', 'CRDT documents — self-clustering (Postgres op-log + Electric)')}
${guide('tanstack-db', 'collections', 'TanStack DB sync adapter — client joins + optimistic mutations')}

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
