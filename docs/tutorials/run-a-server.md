<script setup>
import ServerBootDemo from '../.vitepress/theme/components/demos/ServerBootDemo.vue'
</script>

# Tutorial 1 · Run a super-line server

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <strong>1 · Run a server</strong> → <a href="/tutorials/connect-a-client">2 · Connect a typed client</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
Everything in super-line starts with two files: a <strong>contract</strong> that declares every interaction in your app, and a <strong>server</strong> that implements it. In this lesson you write both and boot the server on a WebSocket wire. Nothing connects to it yet — that's the next lesson — but you'll see it running, twice: once in your terminal, and once <strong>live in this page</strong>.
</p>

<p class="sl-qs-meta">
  <span>~6 minutes</span>
  <span>Node 18+</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Declare</b> <code>defineContract</code></span>
  <span class="sl-qs-pill"><b>Implement</b> <code>srv.implement</code></span>
  <span class="sl-qs-pill"><b>Boot</b> <code>server.listen</code></span>
</p>

</div>

## First, see it run

This isn't a video. Press the button and a **real `createSuperLineServer`** — the same npm package you're about to install — boots inside this browser tab and streams its own internal diagnostics into the pane. The probe buttons preview what a client will do in [Tutorial 2](/tutorials/connect-a-client).

<ServerBootDemo />

One substitution makes this possible: in the tab, the server listens on the **loopback transport** instead of WebSocket. That's not a cheat — it's the first lesson. The wire is a **pluggable transport** (WebSocket by default; HTTP-SSE, libp2p, and in-memory loopback also ship), and everything you write above the transport line is identical on every wire. Your terminal build below uses WebSocket; the page uses loopback; the server code is the same.

## 1. Scaffold the project

Create a folder and two source files (the client joins in the next lesson):

```bash
mkdir my-line && cd my-line
npm init -y
mkdir src
```

```
my-line/
├─ package.json
├─ tsconfig.json
└─ src/
   ├─ contract.ts   # the single source of truth — later imported by BOTH sides
   └─ server.ts     # implements it
```

## 2. Install

You need `core` (the contract), `server`, a transport, and `zod` for the schemas. [`tsx`](https://tsx.is) runs TypeScript directly — no build step while you learn.

::: code-group

```bash [pnpm]
pnpm add @super-line/core @super-line/server @super-line/transport-websocket zod
pnpm add -D tsx typescript
```

```bash [npm]
npm install @super-line/core @super-line/server @super-line/transport-websocket zod
npm install -D tsx typescript
```

```bash [yarn]
yarn add @super-line/core @super-line/server @super-line/transport-websocket zod
yarn add -D tsx typescript
```

:::

super-line is ESM-only, so `package.json` needs `"type": "module"`:

::: code-group

```json [package.json]
{
  "name": "my-line",
  "type": "module",
  "scripts": {
    "server": "tsx src/server.ts"
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

> **Node version.** Every package declares `engines.node >= 18`. (On Node < 22 the *client* — next lesson — needs a `WebSocket` shim; the server does not.)

## 3. Define the contract

The contract is one plain TypeScript module holding **every interaction in the app**, split by direction (`clientToServer` / `serverToClient`) and scoped by role (a `shared` base plus one block per role). This one declares all three wire patterns — a **request**, a pushed **event**, and a subscribable **topic** — for a tiny room-chat app:

```ts [src/contract.ts]
import * as z from 'zod'
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

No client imports this yet — and that's the point: the contract exists *before* either side, and both will be typed by it. See [The contract model](/concepts/the-contract) for roles, directions, and every interaction flavor.

## 4. Implement it and boot

The server is **authoritative**: `authenticate` runs once per connection and fixes its role; every handler receives schema-validated input plus the `ctx` you returned; rooms are server-controlled membership.

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
      srv.publish('presence', { room, count: srv.room(room).size }) // push the shared topic
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

## 5. Run it

```bash
npm run server
```

```ansi
super-line server on ws://localhost:3000
```

That's a live server holding a typed surface — requests it validates, an event and a topic it can push — waiting for its first connection.

### See its internals, like the demo does

The log pane in the demo above isn't invented — it's super-line's own [LogTape](/how-to/debugging-with-logs) diagnostics. Two lines turn them on in your terminal too:

```ts
import { enableSuperLineLogging } from '@super-line/core'
enableSuperLineLogging({ level: 'debug' }) // pretty console, secrets redacted
```

Re-run the server with these at the top of `server.ts` and you'll see the same `conn` / `dispatch` categories the in-page pane shows.

<div class="sl-result">
  <p class="sl-result__h">You have a running, typed, validating server.</p>
  <p>The demo at the top of this page is this exact code on the loopback wire. Boot it, connect the probe, call <code>join('lobby')</code> — the log lines you see (<code>connection accepted</code>, <code>request join</code>) are what your terminal server will emit the moment something connects. Which is the next lesson.</p>
</div>

## What just happened

| What you wrote | What it does |
| --- | --- |
| `defineContract({ shared, roles })` | Declares every interaction once — requests, events, topics — typed and schema-backed. |
| `transports: [webSocketServerTransport(…)]` | Picks the wire. Loopback (the demo), HTTP-SSE, and libp2p plug into the same slot. |
| `authenticate(h)` | Runs at connect, fixes the connection's **role**, returns the `ctx` every handler sees. Throw to reject. |
| `srv.implement({ shared, user })` | Type-checked handlers for each role block. Input arrives **already validated**. |
| `srv.room(…)` / `srv.publish(…)` | Server-owned rooms and topic pushes — clients can't broadcast, they can only ask. |

## Next: connect to it

A server with nobody to talk to is only half the story. The other half imports **the same contract** — and gets the entire surface typed for free.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/connect-a-client">Tutorial 2 · Connect a typed client →</a></strong> — call the request, listen for the event, subscribe to the topic, and watch the server reject an invalid payload.</p>
</div>

### Or branch off from here

- [The contract model](/concepts/the-contract) — roles, directions, and interaction flavors in depth.
- [Choose a transport](/how-to/choose-a-transport) — WebSocket vs. HTTP-SSE vs. libp2p vs. loopback.
- [Authenticate & assign roles](/how-to/roles-auth) — multi-role surfaces and connect-time auth.
- [Debug with logs](/how-to/debugging-with-logs) — the logging you just switched on, in depth.
