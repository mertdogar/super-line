# super-line

A typesafe WebSocket library for TypeScript. One **contract** is the single source of truth; the server implements it and the client calls it with full end-to-end type inference. Three interaction patterns over one connection:

- **req/res** — unary request/response (`await client.sendMessage(...)`), typed errors, timeout + `AbortSignal`
- **events** — server-pushed messages, including **room** broadcasts (`client.on('message', ...)`)
- **topics** — client-subscribed pub/sub streams (`client.subscribe('prices', ...)`)

Rooms and topics ride a single fan-out **adapter**, so it scales across processes (in-memory for one node, Redis for many) with no API change.

## Why

- **Contract-first, validator-agnostic** — define one contract with any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType). Types flow to both ends with zero codegen.
- **Server validates all inbound** automatically; the client can opt into inbound validation to catch version drift.
- **Resilient client** — auto-reconnect with jittered backoff, automatic topic re-subscription, in-flight requests rejected on drop, calls made while reconnecting are queued and flushed.
- **Composable** — attaches to your existing `http.Server` (Express/Fastify/Hono/raw), lifecycle hooks + middleware, pluggable serializer (JSON default; superjson/msgpack drop-ins).

## Install

```bash
pnpm add @super-line/core @super-line/server @super-line/client zod
# optional
pnpm add @super-line/adapter-redis   # multi-node fan-out
pnpm add @super-line/react           # React hooks
```

Requirements: **Node 18+** (server). The client uses the global `WebSocket` (browsers, and Node 22+) — on older Node, pass `{ WebSocket }`.

## Quickstart

### 1. Define the contract (shared)

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  messages: {
    join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
  },
  events: {
    message: z.object({ room: z.string(), text: z.string(), from: z.string() }),
  },
  topics: {
    presence: z.object({ room: z.string(), count: z.number() }),
  },
})
```

### 2. Server

```ts
import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { chat } from './contract'

const server = http.createServer() // or pass your Express/Fastify http.Server
const srv = createSocketServer(chat, {
  server,
  authenticate: (req) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('name')
    if (!name) throw new Error('unauthorized') // throw -> 401 at the upgrade, no socket
    return { name } // becomes ctx in every handler
  },
})

srv.implement({
  join: async ({ room }, ctx, conn) => {
    srv.room(room).add(conn)                                  // server-controlled membership
    srv.publish('presence', { room, count: srv.room(room).size })
    return { ok: true }
  },
  send: async ({ room, text }, ctx) => {
    srv.room(room).broadcast('message', { room, text, from: ctx.name }) // -> client.on('message')
    return { id: crypto.randomUUID() }
  },
})

server.listen(3000)
```

### 3. Client

```ts
import { createClient } from '@super-line/client'
import { chat } from './contract'

const client = createClient(chat, {
  url: 'ws://localhost:3000',
  params: { name: 'ada' },     // -> ?name=ada, read in authenticate
  validate: 'inbound',          // optional: re-validate server->client payloads (great in dev)
})

client.on('message', (m) => console.log(`${m.from}: ${m.text}`)) // typed
const sub = client.subscribe('presence', (p) => console.log(`${p.count} online`))

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hi' }) // typed input/output; throws typed SocketError on failure

sub.unsubscribe()
client.close()
```

Errors arrive as a typed `SocketError` with a `code`:

```ts
import { SocketError } from '@super-line/core'
try {
  await client.send({ room: 'lobby', text: 'hi' })
} catch (e) {
  if (e instanceof SocketError && e.code === 'UNAUTHORIZED') { /* ... */ }
}
```

## React

```tsx
import { createClient } from '@super-line/client'
import { createSocketReact } from '@super-line/react'
import { chat } from './contract'

const { Provider, useRequest, useEvent, useSubscription } = createSocketReact<typeof chat>()

function Root() {
  const [client] = useState(() => createClient(chat, { url: 'ws://localhost:3000', params: { name: 'ada' } }))
  return <Provider client={client}><Room room="lobby" /></Provider>
}

function Room({ room }: { room: string }) {
  const { call: send, isLoading } = useRequest('send')
  const presence = useSubscription('presence')   // latest { room, count } | undefined
  const [log, setLog] = useState<string[]>([])
  useEvent('message', (m) => setLog((l) => [...l, `${m.from}: ${m.text}`]))
  // ...
}
```

## Multi-node (Redis)

The same code scales across processes — just give every server a shared adapter:

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
const srv = createSocketServer(chat, { server, adapter: createRedisAdapter('redis://localhost:6379') })
```

Room broadcasts and topic publishes now fan out to clients connected to any node.

## Examples

```bash
pnpm install

# Node end-to-end (one server + two clients, prints the flow):
pnpm --filter @super-line/example-chat start

# Browser React chat (Vite + WS server, two tabs to chat live):
pnpm --filter @super-line/example-react-chat dev
# open http://localhost:5173
```

## Development

```bash
pnpm test        # vitest (integration over real loopback; redis test auto-skips without Docker)
pnpm typecheck   # tsc across all packages
pnpm lint        # oxlint
pnpm build       # tsup, dual ESM + CJS + d.ts
```

## Packages

| Package | Purpose |
| --- | --- |
| `@super-line/core` | `defineContract`, validation, wire protocol, `Serializer` / `Adapter` interfaces, `SocketError` |
| `@super-line/server` | `createSocketServer` over `ws`, rooms, topics, middleware, in-memory adapter |
| `@super-line/client` | `createClient` (reconnect, typed calls, `on`/`subscribe`) |
| `@super-line/adapter-redis` | Redis Pub/Sub adapter for multi-node fan-out |
| `@super-line/react` | `createSocketReact` → `useRequest` / `useEvent` / `useSubscription` |

## Status

Pre-1.0. Implemented: req/res, events, rooms, topics, auth, reconnect, middleware, in-memory + Redis adapters, React hooks. Not yet: NATS adapter, wildcard/retained topics, session resume/replay, parameterized-topic type inference (topics are typed by exact contract key for now), backpressure safeguards.
