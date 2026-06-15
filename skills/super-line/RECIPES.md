# super-line — recipes & best practices

End-to-end patterns. All code uses the real, verified API. Start from the **Starter**, then layer the others in.

## Starter (copy-paste)

```ts
// contract.ts  — shared by server and client
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  messages: {
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

```ts
// server.ts
import http from 'node:http'
import { createSocketServer } from '@super-line/server'
import { api } from './contract.js'

const server = http.createServer()
const srv = createSocketServer(api, {
  server,
  authenticate: (req) => {
    const name = new URL(req.url ?? '', 'http://localhost').searchParams.get('name')
    if (!name) throw new Error('unauthorized') // -> 401 at the upgrade
    return { name }
  },
})

srv.implement({
  send: async ({ room, text }, ctx) => {
    srv.room(room).broadcast('message', { room, text, from: ctx.name })
    return { id: crypto.randomUUID() }
  },
})

server.listen(3000)
```

```ts
// client.ts
import { createClient } from '@super-line/client'
import { api } from './contract.js'

const client = createClient(api, { url: 'ws://localhost:3000', params: { name: 'ada' } })
client.on('message', (m) => console.log(`${m.from}: ${m.text}`))
await client.send({ room: 'lobby', text: 'hi' })
```

## Auth at the upgrade (token → ctx)

```ts
const srv = createSocketServer(api, {
  server,
  authenticate: async (req) => {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
    const user = await verifyJwt(token)        // throw to reject with 401 (no socket opened)
    return { user }                            // ctx.user available in every handler
  },
})
// client: createClient(api, { url, params: { token } })
```

## Authorize topic subscriptions (private streams)

```ts
const srv = createSocketServer(api, {
  server, authenticate,
  authorizeSubscribe: async (topic, ctx) => {
    if (topic.startsWith('org:')) return ctx.user.orgs.includes(topic.slice(4))
    return true                                // return false or throw -> client's sub.ready rejects FORBIDDEN
  },
})
```

## Middleware (rate-limit, metrics, per-message authz)

```ts
const srv = createSocketServer(api, {
  server, authenticate,
  use: [
    async (ctx, info, next) => { rateLimit(ctx.user, info.name); await next() },        // throw to reject
    async (_ctx, info, next) => { const t = Date.now(); await next(); metric(info.name, Date.now() - t) },
  ],
})
// info = { kind: 'request' | 'subscribe', name, conn }; call next() to proceed.
```

## Rooms: join + broadcast (the canonical pattern)

```ts
// contract.messages.join: { input: { room }, output: { ok: boolean } }
srv.implement({
  join: async ({ room }, _ctx, conn) => {
    srv.room(room).add(conn)                   // server-controlled membership
    return { ok: true }
  },
  send: async ({ room, text }, ctx) => {
    srv.room(room).broadcast('message', { room, text, from: ctx.user.id })  // -> client.on('message')
    return { id: nano() }
  },
})
// client: await client.join({ room }); client.on('message', render)
// On reconnect the client must re-run join() (rooms are server-controlled, not auto-restored).
```

## Direct message to a user — cross-node safe

Don't stash a `conn` to DM someone (it's node-local). Put each user in a per-user room and broadcast to it:

```ts
onConnection: (conn, ctx) => srv.room(`user:${ctx.user.id}`).add(conn),
// later, from anywhere (any node):
srv.room(`user:${targetId}`).broadcast('dm', { from, text })
```

## Presence via a topic

```ts
// topics.presence: { room, count }
const counts = new Map<string, number>()
const bump = (room: string, d: number) => { const n = Math.max(0, (counts.get(room) ?? 0) + d); counts.set(room, n); return n }

srv.implement({
  join: async ({ room }, _ctx, conn) => {
    srv.room(room).add(conn)
    srv.publish('presence', { room, count: bump(room, +1) })   // server-only publish
    return { ok: true }
  },
})
onDisconnect: (conn, _ctx) => { /* look up the conn's room, publish presence with bump(room, -1) */ }
// client: const sub = client.subscribe('presence', p => setOnline(p.count)); await sub.ready
```

## Client → others (clients can't publish)

```ts
// ❌ clients cannot publish to topics
// ✅ send a message; the server validates/authorizes, then fans out
srv.implement({
  setPrice: async ({ symbol, price }, ctx) => {
    if (!ctx.user.canTrade) throw new SocketError('FORBIDDEN')
    srv.publish('prices', { symbol, price })
    return { ok: true }
  },
})
```

## Multi-node (Redis) — same code, scaled

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
const srv = createSocketServer(api, { server, authenticate, adapter: createRedisAdapter('redis://localhost:6379') })
// every server process gets an adapter pointing at the same Redis; room broadcasts + publishes now fan out across nodes.
```

## Typed error handling

```ts
import { SocketError } from '@super-line/core'

// server
throw new SocketError('NOT_FOUND', 'no such room', { room })   // code reaches the client

// client
try { await client.send({ room, text }) }
catch (e) {
  if (e instanceof SocketError && e.code === 'UNAUTHORIZED') relogin()
  // codes: BAD_REQUEST UNAUTHORIZED FORBIDDEN NOT_FOUND TIMEOUT VALIDATION DISCONNECTED INTERNAL
}
```

## Reconnect & delivery — design for it

- Delivery is **at-most-once**; messages sent while a client is offline are dropped (no replay yet).
- Make handlers **idempotent**; after a reconnect the client auto-re-subscribes topics but must **re-run room joins**.
- In-flight requests reject `DISCONNECTED` on drop; calls during reconnect are queued and flushed.
- A 401 looks like any drop over the WS API, so a bad-credential client retries forever unless you set `reconnect: false`.

## Testing

Test super-line by booting a **real server** on an ephemeral port and a **real client** (exercises the actual handshake + frames), then asserting through two kinds of "hooks":

- **Server lifecycle hooks** (`onConnection`, `onDisconnect`, `onError`) — observation seams: capture the server-side `conn`, count connects, assert disconnects, capture server-side errors.
- **React hooks** — render `useRequest` / `useSubscription` / `useEvent` against a real client with `renderHook`.

These snippets are distilled from super-line's own (passing) suite. They use [Vitest](https://vitest.dev).

### A tiny harness (reuse across tests)

```ts
// test/harness.ts
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Contract } from '@super-line/core'
import { createSocketServer, type ServerOptions, type SocketServer } from '@super-line/server'
import { createClient, type Client, type ClientOptions } from '@super-line/client'

export function createHarness() {
  const cleanups: Array<() => Promise<void> | void> = []

  async function server<C extends Contract, Ctx = undefined>(
    contract: C, opts: Omit<ServerOptions<Ctx>, 'server'> = {},
  ): Promise<{ srv: SocketServer<C, Ctx>; url: string }> {
    const httpServer = http.createServer()
    const srv = createSocketServer<C, Ctx>(contract, { ...opts, server: httpServer })
    await new Promise<void>((r) => httpServer.listen(0, r))
    const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    cleanups.push(async () => { await srv.close(); await new Promise<void>((r) => httpServer.close(() => r())) })
    return { srv, url }
  }
  function client<C extends Contract>(contract: C, opts: ClientOptions): Client<C> {
    const c = createClient(contract, opts)
    cleanups.unshift(() => c.close())          // clients close BEFORE the servers they connect to
    return c
  }
  async function dispose() { for (const fn of cleanups.splice(0)) await fn() }
  return { server, client, dispose }
}

export const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms))
export async function waitFor(pred: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!pred()) { if (Date.now() - start > timeout) throw new Error('waitFor timeout'); await tick(5) }
}
```

A shared contract for the examples below:

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'
export const api = defineContract({
  messages: {
    echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
    boom: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
  },
  events: { ping: z.object({ n: z.number() }) },
  topics: { feed: z.object({ n: z.number() }), secret: z.object({ x: z.string() }) },
})
```

### Round-trip + typed error

```ts
import { afterEach, expect, it } from 'vitest'
import { SocketError } from '@super-line/core'
import { createHarness } from './harness'
import { api } from './api'

const h = createHarness()
afterEach(() => h.dispose())

it('round-trips and surfaces typed errors', async () => {
  const { srv, url } = await h.server(api, { authenticate: () => ({}) })
  srv.implement({
    echo: async ({ text }) => ({ text }),
    boom: async () => { throw new SocketError('FORBIDDEN', 'nope') },
  })
  const client = h.client(api, { url })
  expect(await client.echo({ text: 'hi' })).toEqual({ text: 'hi' })
  await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
```

### Lifecycle hooks as test seams

```ts
import type { Conn } from '@super-line/server'

it('observes connect / disconnect / errors via hooks', async () => {
  const events: string[] = []
  let captured: Conn<{ id: string }> | undefined
  const { srv, url } = await h.server(api, {
    authenticate: () => ({ id: 'u1' }),
    onConnection: (conn) => { captured = conn; events.push('connect') },
    onDisconnect: () => events.push('disconnect'),
    onError: (err) => events.push(`error:${(err as SocketError).code}`),
  })
  srv.implement({ echo: async ({ text }) => ({ text }), boom: async () => { throw new SocketError('FORBIDDEN') } })

  const client = h.client(api, { url, reconnect: false })
  await client.echo({ text: 'x' })
  expect(events).toContain('connect')
  expect(captured?.ctx.id).toBe('u1')          // the captured server-side conn carries ctx

  await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(events).toContain('error:FORBIDDEN')  // onError saw the thrown SocketError

  client.close()
  await waitFor(() => events.includes('disconnect'))
})
```

### Auth: reject at the upgrade (no socket)

```ts
it('rejects a bad token and never opens a socket', async () => {
  let connects = 0
  const { srv, url } = await h.server(api, {
    authenticate: (req) => {
      const token = new URL(req.url ?? '', 'http://x').searchParams.get('token')
      if (token !== 'good') throw new Error('unauthorized')
      return {}
    },
    onConnection: () => { connects++ },
  })
  srv.implement({ echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) })

  // reconnect:false so the failure surfaces immediately (a 401 looks like any drop over the WS API)
  const client = h.client(api, { url, params: { token: 'bad' }, reconnect: false })
  await expect(client.echo({ text: 'x' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(connects).toBe(0)
})
```

### Topics: authorize + deliver

```ts
it('denies an unauthorized subscribe and delivers an authorized one', async () => {
  const { srv, url } = await h.server(api, {
    authenticate: () => ({}),
    authorizeSubscribe: (topic) => topic !== 'secret',
  })
  srv.implement({ echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) })
  const client = h.client(api, { url })

  await expect(client.subscribe('secret', () => {}).ready).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready
  srv.publish('feed', { n: 1 })
  await waitFor(() => got.length === 1)
})
```

### Reconnect: simulate a drop with `conn.ws.terminate()`

```ts
import type { Conn } from '@super-line/server'

it('auto-reconnects, re-subscribes, and rejects in-flight on drop', async () => {
  let last: Conn<unknown> | undefined
  const { srv, url } = await h.server(api, { authenticate: () => ({}), onConnection: (c) => { last = c } })
  srv.implement({ echo: async ({ text }) => ({ text }), boom: () => new Promise<never>(() => {}) /* hangs */ })
  const client = h.client(api, { url, reconnectBaseMs: 10, reconnectMaxMs: 50 })

  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready

  const inflight = client.boom({})              // never resolves server-side
  await tick(20)                                // ensure it's sent
  const first = last
  first!.ws.terminate()                         // simulate a network drop

  await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' })   // in-flight rejects
  await waitFor(() => last !== first && client.connected, 3000)            // reconnected (new conn)
  srv.publish('feed', { n: 1 })
  await waitFor(() => got.length === 1, 3000)                              // topic auto-re-subscribed
})
```

### Cross-node without Redis (shared in-memory bus)

```ts
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'

it('fans out across two nodes sharing one bus', async () => {
  const bus = new MemoryBus()
  const a = await h.server(api, { authenticate: () => ({}), adapter: createInMemoryAdapter(bus) })
  const b = await h.server(api, { authenticate: () => ({}), adapter: createInMemoryAdapter(bus) })
  for (const n of [a, b]) n.srv.implement({ echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) })

  const client = h.client(api, { url: a.url })  // connected to node A only
  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready
  b.srv.publish('feed', { n: 7 })               // published on node B
  await waitFor(() => got.length === 1)         // received on node A
})
```

### React hooks (`renderHook`)

```ts
// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createSocketReact } from '@super-line/react'
import { createHarness } from './harness'
import { api } from './api'

const { Provider, useRequest } = createSocketReact<typeof api>()
const h = createHarness()
afterEach(() => { cleanup(); return h.dispose() })

it('useRequest performs a typed call and exposes state', async () => {
  const { srv, url } = await h.server(api, { authenticate: () => ({}) })
  srv.implement({ echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) })
  const client = h.client(api, { url })

  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { client, children })
  const { result } = renderHook(() => useRequest('echo'), { wrapper })

  await act(async () => { await result.current.call({ text: 'hi' }) })
  expect(result.current.data).toEqual({ text: 'hi' })
  expect(result.current.isLoading).toBe(false)
})
```

### Tips

- **Close the client before the server** — an open connection blocks `server.close()` (the harness handles this via `unshift`).
- `backoffDelay` is a **pure function** — unit-test it directly (no timers or sockets): `expect(backoffDelay(0, opts)).toBeLessThanOrEqual(opts.maxMs)`.
- Prefer a small `reconnectBaseMs` + `waitFor` over fake timers — `vi.useFakeTimers()` is brittle alongside real sockets (real I/O isn't faked).
- For **real cross-process** tests, use `testcontainers` + `createRedisAdapter(url)`, and skip cleanly when Docker is absent (`describe.skipIf`). For a cross-node **room** broadcast, `room.add → adapter.subscribe` is fire-and-forget, so poll the broadcast until it lands (the SUBSCRIBE-propagation window is a non-issue in real apps).
