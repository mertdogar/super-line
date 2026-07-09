# Tutorial 1 · Your first typed round-trip

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <strong>1 · Your first typed round-trip</strong> → <a href="/tutorials/first-collection">2 · Your first collection</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
Stand up a typed realtime round-trip from an empty folder. You write <strong>one contract</strong>; the server implements it and the client calls it with full end-to-end inference — no codegen. By the end you'll have a running server and a client that does all three wire patterns at once.
</p>

<p class="sl-qs-meta">
  <span>~5 minutes</span>
  <span>Node 18+</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Request</b> <code>send()</code></span>
  <span class="sl-qs-pill"><b>Event</b> <code>on('message')</code></span>
  <span class="sl-qs-pill"><b>Topic</b> <code>subscribe('presence')</code></span>
</p>

</div>

The wire is **pluggable** — WebSocket by default, with HTTP (SSE / long-poll) and libp2p also available (see [Choose a transport](/how-to/choose-a-transport)). This tutorial uses WebSocket; everything above the transport line is identical on every wire.

> **Node version.** Every package declares `engines.node >= 18`, so **Node 18+** is the baseline (on Node < 22 the client needs a `WebSocket` shim — see the note in step 5). The libp2p / NAT-traversal examples are the exception: they run on **Node 24+** because they rely on the global WebCrypto API.

## 1. Scaffold the project

Create a folder and three source files. The contract is the one module **both** sides import — that's what keeps them in sync.

```bash
mkdir my-line && cd my-line
npm init -y
mkdir src
```

You're building toward this layout:

```
my-line/
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ contract.ts   # the single source of truth — imported by both sides
   ├─ server.ts     # implements the contract
   └─ client.ts     # calls it, fully typed
```

## 2. Install

You need `core` (the contract), `server`, `client`, a transport, and `zod` for the schemas.

::: code-group

```bash [pnpm]
pnpm add @super-line/core @super-line/server @super-line/client @super-line/transport-websocket zod
pnpm add -D tsx typescript
```

```bash [npm]
npm install @super-line/core @super-line/server @super-line/client @super-line/transport-websocket zod
npm install -D tsx typescript
```

```bash [yarn]
yarn add @super-line/core @super-line/server @super-line/client @super-line/transport-websocket zod
yarn add -D tsx typescript
```

:::

We use [`tsx`](https://tsx.is) to run TypeScript directly — no build step while you're learning.

Now wire up the two config files. super-line is ESM-only, so `package.json` needs `"type": "module"`:

::: code-group

```json [package.json]
{
  "name": "my-line",
  "type": "module",
  "scripts": {
    "server": "tsx src/server.ts",
    "client": "tsx src/client.ts"
  }
}
```

```json [tsconfig.json]
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

:::

## 3. Define the contract

The contract is split by **direction** (`clientToServer` / `serverToClient`) and scoped by **role** (a `shared` base plus one block per role). This one file holds every interaction in the app — a request, a pushed event, and a subscribable topic.

```ts [src/contract.ts]
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  shared: {
    clientToServer: {
      // request: input is validated, output is typed back to the caller
      join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      // event: the server pushes this; clients listen with `.on()`
      message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
      // topic: same shape, but `subscribe: true` lets clients `.subscribe()` to it
      presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true },
    },
  },
  roles: {
    user: {
      clientToServer: {
        send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
      },
    },
  },
})
```

See [The contract model](/concepts/the-contract) for the full picture — directions, roles, and every interaction flavor.

## 4. Implement the server

The server owns rooms and authorization. `authenticate` runs once per connection and fixes the role; every handler then receives the validated input plus the `ctx` you returned.

```ts [src/server.ts]
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { chat } from './contract'

const server = http.createServer() // or hand in your Express / Fastify http.Server

const srv = createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => {
    const name = h.query.name // the Handshake: { transport, headers, query, peer?, raw }
    if (!name) throw new Error('unauthorized') // throw → rejected at the WS upgrade, no socket
    return { role: 'user' as const, ctx: { name } } // ctx is handed to every handler
  },
})

srv.implement({
  shared: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn) // membership is server-controlled
      srv.forRole('user').publish('presence', { room, count: srv.room(room).size }) // push the topic
      return { ok: true }
    },
  },
  user: {
    send: async ({ room, text }, ctx) => {
      srv.room(room).broadcast('message', { room, text, from: ctx.name }) // → every client.on('message')
      return { id: randomUUID() }
    },
  },
})

server.listen(3000, () => console.log('super-line server on ws://localhost:3000'))
```

## 5. Write the client

The client imports the **same** contract, so `join`, `send`, `on`, and `subscribe` are all inferred — wrong event names and bad payloads are compile errors, not runtime surprises.

```ts [src/client.ts]
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chat } from './contract'

const client = createSuperLineClient(chat, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user', // narrows the surface to shared ∪ user; verified by authenticate
  params: { name: 'ada' }, // carried in the handshake → readable as h.query.name
})

client.on('message', (m) => console.log(`💬 ${m.from}: ${m.text}`)) // event
client.subscribe('presence', (p) => console.log(`👥 ${p.count} online in ${p.room}`)) // topic

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hello, super-line' }) // request → typed { id }

await new Promise((r) => setTimeout(r, 300)) // let the pushes land, then exit
client.close()
```

::: warning Node 18 / 20: provide a WebSocket
The client uses the global `WebSocket`, which exists in browsers and **Node 22+**. On older Node, install `ws` and pass it through: `webSocketClientTransport({ url, WebSocket })`.
:::

## 6. Run it

Start the server, then the client in a second terminal:

::: code-group

```bash [Terminal 1 · server]
npm run server
```

```bash [Terminal 2 · client]
npm run client
```

:::

The client prints:

```ansi
👥 1 online in lobby
💬 ada: hello, super-line
```

<div class="sl-result">
  <p class="sl-result__h">That's a full typed round-trip.</p>
  <p>One contract, three wire patterns, end to end. The <code>presence</code> line is a <strong>topic</strong> the server pushed on join; the <code>ada: …</code> line is an <strong>event</strong> broadcast from your <code>send</code> <strong>request</strong> — all over a single connection, with zero codegen.</p>
</div>

## What just happened

Each call you wrote maps to one of super-line's wire patterns, all sharing one connection and one contract:

| Your client call | Pattern | What it does |
| --- | --- | --- |
| `await client.send(…)` | **Request** | Validated input in, typed `{ id }` back — like an RPC. |
| `client.on('message', …)` | **Event** | The server pushes; you listen. Fire-and-forget. |
| `client.subscribe('presence', …)` | **Topic** | You opt in; the server fans out to every subscriber. |

Rename a field in `contract.ts` and the other side stops compiling — that's the whole point. And types aren't trust: every inbound payload is re-validated against the schema on the server, so even an untyped peer can't slip a bad message through.

## Next: give it memory

You just moved messages. The next leap is **persisted, typed state** the server owns and streams to every client — that's a [collection](/collections/).

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/first-collection">Tutorial 2 · Your first collection →</a></strong> — declare a collection on the contract, secure it with a row policy, and subscribe to a live filtered row-set.</p>
</div>

### Or branch off from here

- [The contract model](/concepts/the-contract) — roles, direction, and the interaction flavors in depth.
- [Push events & broadcast to rooms](/how-to/events-rooms) and [Subscribe to topics](/how-to/topics) — the push patterns you just used.
- [Authenticate & assign roles](/how-to/roles-auth) — give `agent` (or admin) connections a different surface.
- [Use the React hooks](/how-to/react) — the same contract through typed hooks.
- [Choose an adapter](/how-to/choose-an-adapter) — go multi-node with one extra line.
- [API reference](/reference/) — every export, option, and type.
