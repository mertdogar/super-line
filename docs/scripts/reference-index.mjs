// Rewrites the typedoc-generated reference/index.md with a curated front door.
// typedoc only extracts 8 packages (transport-*/store-* extraction produces
// README dumps — see memory/typedoc quirk), so those link to their guides
// instead of silently missing from the list.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const api = (pkg, blurb) => `- [\`@super-line/${pkg}\`](@super-line/${pkg}/index.md) — ${blurb}`
const guide = (pkg, path, blurb) => `- [\`@super-line/${pkg}\`](${path}) — ${blurb} *(guide)*`

const content = `---
lastUpdated: false
---

# API Reference

Start with [\`@super-line/core\`](@super-line/core/index.md) — the contract is the single
source of truth; everything else implements or consumes it. Packages marked *(guide)*
are documented as hands-on guides rather than extracted API pages.

## Cheatsheets

Hand-written quick lookups alongside the generated API:

- [Contract entry shapes](/reference/cheatsheets/contract-shapes) — the five flavors, field by field
- [Wire frames](/reference/cheatsheets/wire-frames) — every \`t\` on the wire
- [Error codes](/reference/cheatsheets/errors) — the built-in \`SuperLineError\` set
- [Server & client options](/reference/cheatsheets/options) — the common configuration

## Core

${api('core', '`defineContract`, wire types, `SuperLineError`, transport & collection interfaces')}
${api('server', '`createSuperLineServer` — implements the contract, owns rooms/topics/auth, cluster bus, collection co-writers')}
${api('client', '`createSuperLineClient` — calls the contract with full inference, reconnection, collections')}
${api('react', '`createSuperLineHooks` — typed hooks over the client (requests, events, `useCollection`/`useDoc`)')}

## Transports — the client ↔ server wire

${guide('transport-websocket', '/how-to/transport-websocket', 'WebSocket wire, the default')}
${guide('transport-http', '/how-to/transport-http', 'HTTP wire — SSE stream or long-poll')}
${guide('transport-libp2p', '/how-to/transport-libp2p', 'libp2p wire — WebRTC, NAT traversal, bring-your-own node')}
${guide('transport-loopback', '/how-to/transport-loopback', 'in-memory wire for tests')}

## Collections — typed, contract-declared persisted state

${guide('collections-memory', '/collections/backends', 'typed LWW rows — in-memory · relay')}
${guide('collections-sqlite', '/collections/backends', 'typed LWW rows — durable (better-sqlite3) · relay')}
${guide('collections-pglite', '/collections/backends', 'typed LWW rows — self-clustering (Postgres + Electric)')}
${guide('collections-crdt-memory', '/collections/crdt-documents', 'CRDT documents — in-memory + the universal client engine')}
${guide('collections-crdt-libsql', '/collections/crdt-documents', 'CRDT documents — durable (libSQL/Turso) · relay')}
${guide('collections-crdt-pglite', '/collections/crdt-documents', 'CRDT documents — self-clustering (Postgres op-log + Electric)')}
${guide('tanstack-db', '/collections/tanstack-db', 'TanStack DB sync adapter — client joins + optimistic mutations')}

## Adapters — server ↔ server fan-out

${api('adapter-redis', 'Redis pub/sub backbone')}
${api('adapter-libp2p', 'broker-less gossipsub backbone')}
${api('adapter-zeromq', 'ZeroMQ backbone')}
${api('adapter-rabbitmq', 'RabbitMQ backbone')}

## Tooling

${guide('control-center', '/how-to/control-center', 'debug webapp — topology, live traffic, presence (`npx @super-line/control-center`)')}
`

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'reference', 'index.md')
writeFileSync(out, content)
console.log(`reference-index: wrote ${out}`)
