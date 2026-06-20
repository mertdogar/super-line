# Getting started

super-line is a typesafe WebSocket library for TypeScript. You write **one contract**; the server implements it and the client calls it with full end-to-end type inference — no codegen.

## Install

```bash
pnpm add @super-line/core @super-line/server @super-line/client zod
# optional
pnpm add @super-line/adapter-redis   # multi-node fan-out
pnpm add @super-line/react           # React hooks
```

Requirements: **Node 18+** (server). The client uses the global `WebSocket` (browsers, and Node 22+); on older Node, pass `{ WebSocket }`.

## 1. Define the contract (shared)

The contract is split by **direction** (`clientToServer` / `serverToClient`) and scoped by **role** (a `shared` base plus one block per role). See [The contract](./the-contract) for the full model.

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const chat = defineContract({
  shared: {
    clientToServer: {
      join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      // { payload } = push event; add `subscribe: true` to make it a client-subscribable topic
      message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) },
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

## 2. Server

```ts
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { chat } from './contract'

const server = http.createServer() // or pass your Express/Fastify http.Server
const srv = createSuperLineServer(chat, {
  server,
  authenticate: (req) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('name')
    if (!name) throw new Error('unauthorized') // throw -> 401 at the upgrade, no socket
    return { role: 'user' as const, ctx: { name } } // role + ctx; ctx in every handler
  },
})

srv.implement({
  shared: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn) // server-controlled membership
      srv.forRole('user').publish('presence', { room, count: srv.room(room).size })
      return { ok: true }
    },
  },
  user: {
    send: async ({ room, text }, ctx) => {
      srv.room(room).broadcast('message', { room, text, from: ctx.name }) // -> client.on('message')
      return { id: crypto.randomUUID() }
    },
  },
})

server.listen(3000)
```

## 3. Client

```ts
import { createSuperLineClient } from '@super-line/client'
import { chat } from './contract'

const client = createSuperLineClient(chat, {
  url: 'ws://localhost:3000',
  role: 'user', // narrows the surface to shared ∪ user; sent to authenticate to verify
  params: { name: 'ada' },
})

client.on('message', (m) => console.log(`${m.from}: ${m.text}`)) // typed
const sub = client.subscribe('presence', (p) => console.log(`${p.count} online`))

await client.join({ room: 'lobby' })
await client.send({ room: 'lobby', text: 'hi' }) // typed input/output; throws typed SuperLineError on failure

sub.unsubscribe()
client.close()
```

## Next steps

- [The contract](./the-contract) — roles, direction, and the interaction flavors in depth.
- [API reference](/reference/) — every export, option, and type.
