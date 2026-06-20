# super-line — recipes & best practices

End-to-end patterns. All code uses the real, verified API. Start from the **Starter**, then layer the others in.

## Starter (copy-paste)

```ts
// contract.ts  — shared by server and client
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  roles: {
    user: {
      clientToServer: {
        send: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) },
      },
      serverToClient: {
        message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) }, // push event
        presence: { payload: z.object({ room: z.string(), count: z.number() }), subscribe: true }, // topic
      },
    },
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
    if (!name) throw new Error('unauthorized')         // -> 401 at the upgrade
    return { role: 'user' as const, ctx: { name } }    // role + ctx; ctx.name in every user handler
  },
})

srv.implement({
  user: {
    send: async ({ room, text }, ctx, conn) => {
      conn.emit('message', { room, text, from: ctx.name }) // or srv.room(room).broadcast(...)
      return { id: crypto.randomUUID() }
    },
  },
})

server.listen(3000)
```

```ts
// client.ts
import { createClient } from '@super-line/client'
import { api } from './contract.js'

const client = createClient(api, { url: 'ws://localhost:3000', role: 'user', params: { name: 'ada' } })
client.on('message', (m) => console.log(`${m.from}: ${m.text}`))
await client.send({ room: 'lobby', text: 'hi' })
```

## Multiple roles (user + agent)

A `user` and an `agent` connect to the same server with different surfaces. A `shared` block is common to both; role enforcement is automatic (a cross-role call gets `NOT_FOUND`).

```ts
export const api = defineContract({
  shared: {
    clientToServer: { join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) } },
    serverToClient: { message: { payload: z.object({ room: z.string(), text: z.string(), from: z.string() }) } },
  },
  roles: {
    user:  { clientToServer: { say:      { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) } } },
    agent: { clientToServer: { announce: { input: z.object({ room: z.string(), text: z.string() }), output: z.object({ id: z.string() }) } } },
  },
})

srv.implement({
  shared: { join: async ({ room }, _ctx, conn) => { srv.room(room).add(conn); return { ok: true } } },
  user:  { say:      async ({ room, text }, ctx) => { srv.room(room).broadcast('message', { room, text, from: ctx.name }); return { id: nano() } } },
  agent: { announce: async ({ room, text }, ctx) => { srv.room(room).broadcast('message', { room, text, from: `🤖 ${ctx.name}` }); return { id: nano() } } },
})

const user  = createClient(api, { url, role: 'user',  params: { name: 'ada' } })
const agent = createClient(api, { url, role: 'agent', params: { name: 'helper' } })
await user.say({ room: 'lobby', text: 'hi' })          // ✓
await agent.announce({ room: 'lobby', text: 'on it' }) // ✓
// user.announce(...) is a COMPILE error (not on the user surface); forced at runtime -> NOT_FOUND
```

In a `user` handler, `ctx` is the user's ctx; in `agent`, the agent's. In a `shared` handler, `ctx` is the union (use common fields, or branch on `conn.role`).

## Auth at the upgrade (token → { role, ctx })

The client's `role` option is a **claim** sent as a query param; resolve the real role from the credential and verify the claim.

```ts
const srv = createSocketServer(api, {
  server,
  authenticate: async (req) => {
    const u = new URL(req.url ?? '', 'http://localhost')
    const user = await verifyJwt(u.searchParams.get('token'))   // throw to reject with 401 (no socket opened)
    if (user.role !== u.searchParams.get('role')) throw new SocketError('FORBIDDEN', 'role not granted')
    return user.role === 'admin'
      ? { role: 'admin' as const, ctx: { user } }
      : { role: 'user' as const, ctx: { user } }
  },
})
// client: createClient(api, { url, role: 'admin', params: { token } })
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
    async (ctx, info, next) => { rateLimit(info.conn.role, info.name); await next() },   // throw to reject
    async (_ctx, info, next) => { const t = Date.now(); await next(); metric(info.name, Date.now() - t) },
  ],
})
// info = { kind: 'request' | 'subscribe', name, conn }; call next() to proceed.
```

## Rooms: join + broadcast (the canonical pattern)

Rooms are **mixed-role**; `broadcast` delivers a **shared** event. Put room-broadcast events in `shared.serverToClient`.

```ts
srv.implement({
  shared: {
    join: async ({ room }, _ctx, conn) => { srv.room(room).add(conn); return { ok: true } },  // server-controlled membership
  },
  user: {
    send: async ({ room, text }, ctx) => {
      srv.room(room).broadcast('message', { room, text, from: ctx.user.id })  // -> client.on('message')
      return { id: nano() }
    },
  },
})
// client: await client.join({ room }); client.on('message', render)
// On reconnect the client must re-run join() (rooms are server-controlled, not auto-restored).
```

## Direct message to a user — cross-node safe

Don't stash a `conn` to DM someone (it's node-local). With an `identify` hook set, target the user directly — `toUser` reaches every device on any node:

```ts
createSocketServer(api, { server, authenticate, identify: (conn) => conn.ctx.user.id })
// later, from anywhere (any node):
srv.toUser(targetId).emit('dm', { from, text })   // 'dm' is a shared event; all the user's devices
srv.toConn(connId).emit('dm', { from, text })     // or one specific connection
```

## Introspection & presence dashboard

```ts
createSocketServer(api, {
  server, authenticate,
  identify: (conn) => conn.ctx.user.id,
  describeConn: (conn) => ({ plan: conn.ctx.user.plan }),
})

// node-local (sync): cheap reads of THIS process
srv.local.connections.length
srv.local.connections.filter((c) => c.role === 'agent')

// cluster-wide (async): reads the presence registry (in-memory or Redis)
await srv.cluster.count()                       // total everywhere
await srv.cluster.topology()                    // [{ nodeId, connections, rooms, alive }]
await srv.cluster.room('lobby')                 // members across nodes
await srv.isOnline(userId)                       // show an online dot
```

## Ask a client a question (server → client request)

```ts
// contract: shared.serverToClient.confirm = { input: z.object({ q: z.string() }), output: z.object({ ok: z.boolean() }) }

// client answers (throw SocketError for a typed failure):
client.implement({ confirm: async ({ q }) => ({ ok: await askUser(q) }) })

// server asks a specific connection (cross-node), awaits the typed reply:
const { ok } = await srv.toConn(connId).request('confirm', { q: 'Deploy now?' }, { timeout: 10_000 })
// to ask a USER, pick a connection first (request is single-target):
const [c] = await srv.cluster.byUser(userId)
if (c) await srv.toConn(c.id).request('confirm', { q: '…' })
```

## Per-connection state (typed)

```ts
// contract: roles.user.data = z.object({ lastSeenMsgId: z.number() })
srv.implement({
  user: {
    ack: async ({ id }, _ctx, conn) => {
      conn.data.lastSeenMsgId = id   // typed, mutable, per-connection
      return {}
    },
  },
})
// seed data (and have it land in the cluster descriptor) from onConnection:
onConnection: (conn) => { conn.data.lastSeenMsgId = 0 }
```

## Presence via a topic

```ts
// roles.user.serverToClient.presence: { payload: { room, count }, subscribe: true }
const counts = new Map<string, number>()
const bump = (room: string, d: number) => { const n = Math.max(0, (counts.get(room) ?? 0) + d); counts.set(room, n); return n }

srv.implement({
  user: {
    join: async ({ room }, _ctx, conn) => {
      srv.room(room).add(conn)
      srv.forRole('user').publish('presence', { room, count: bump(room, +1) })   // role topic, server-only
      return { ok: true }
    },
  },
})
// onDisconnect: (conn) => { /* look up the conn's room, forRole('user').publish('presence', bump(room, -1)) */ }
// client: const sub = client.subscribe('presence', p => setOnline(p.count)); await sub.ready
```

## Client → others (clients can't publish)

```ts
// ❌ clients cannot publish to topics
// ✅ send a request; the server validates/authorizes, then fans out
srv.implement({
  user: {
    setPrice: async ({ symbol, price }, ctx) => {
      if (!ctx.user.canTrade) throw new SocketError('FORBIDDEN')
      srv.forRole('user').publish('prices', { symbol, price })   // role topic
      return { ok: true }
    },
  },
})
```

## Cluster event bus (cluster coordination)

A bus channel is just a **shared topic**. One `server.publish` fans out to three kinds of subscriber at once: same-node `server.subscribe` listeners (local echo, in-process, no Redis/WS hop), other nodes' `server.subscribe` listeners (over the adapter, inbound-validated), and subscribed clients. `server.subscribe` fires for a publish from **any** node including this one — self-exclude with `if (from === srv.nodeId) return`.

```ts
export const api = defineContract({
  shared: { serverToClient: { rebalance: { payload: z.object({ shard: z.number() }), subscribe: true } } },
  roles: { user: {…} },
})

const off = srv.subscribe('rebalance', ({ shard }, { from }) => {
  if (from === srv.nodeId) return        // ignore our own publish (local echo)
  moveShard(shard)
})                                       // returns an unsubscribe fn
srv.publish('rebalance', { shard: 3 })   // -> this node's listeners + every other node + subscribed clients
```

The bus is **opt-in** pub/sub on a shared topic. It's a different tool from server-CHOSEN **events** (`conn.emit` / `room.broadcast` / `toConn(id).emit` / `toUser(id).emit`), which have no client opt-in and no server-side subscribe.

## Multi-node (Redis) — same code, scaled

```ts
import { createRedisAdapter } from '@super-line/adapter-redis'
const srv = createSocketServer(api, { server, authenticate, adapter: createRedisAdapter('redis://localhost:6379') })
// every server process gets an adapter pointing at the same Redis; rooms, topics, AND the cluster event bus fan out across nodes.
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
import type { Contract, RoleOf } from '@super-line/core'
import { createSocketServer, type AuthResult, type ServerOptions, type SocketServer } from '@super-line/server'
import { createClient, type Client, type ClientOptions } from '@super-line/client'

export function createHarness() {
  const cleanups: Array<() => Promise<void> | void> = []

  async function server<C extends Contract, A extends AuthResult<C>>(
    contract: C, opts: Omit<ServerOptions<C, A>, 'server'>,
  ): Promise<{ srv: SocketServer<C, A>; url: string }> {
    const httpServer = http.createServer()
    const srv = createSocketServer<C, A>(contract, { ...opts, server: httpServer })
    await new Promise<void>((r) => httpServer.listen(0, r))
    const url = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
    cleanups.push(async () => { await srv.close(); await new Promise<void>((r) => httpServer.close(() => r())) })
    return { srv, url }
  }
  function client<C extends Contract, R extends RoleOf<C>>(contract: C, opts: ClientOptions<C, R>): Client<C, R> {
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
  shared: { serverToClient: { ping: { payload: z.object({ n: z.number() }) } } },
  roles: {
    user: {
      clientToServer: {
        echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
        boom: { input: z.object({}), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        feed: { payload: z.object({ n: z.number() }), subscribe: true },
        secret: { payload: z.object({ x: z.string() }), subscribe: true },
      },
    },
  },
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
  const { srv, url } = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }) })
  srv.implement({
    user: {
      echo: async ({ text }) => ({ text }),
      boom: async () => { throw new SocketError('FORBIDDEN', 'nope') },
    },
  })
  const client = h.client(api, { url, role: 'user' })
  expect(await client.echo({ text: 'hi' })).toEqual({ text: 'hi' })
  await expect(client.boom({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
```

### Role enforcement (cross-role → NOT_FOUND)

```ts
it('rejects a cross-role call with NOT_FOUND', async () => {
  const { srv, url } = await h.server(twoRoleApi, { authenticate: (req) => resolveRole(req) })
  srv.implement({ user: { sendMessage: async () => ({ id: '1' }) }, agent: { reportResult: async () => ({ ok: true }) } })

  const user = h.client(twoRoleApi, { url, role: 'user' })
  // bypass the typed surface to prove the runtime boundary
  const call = (user as unknown as { reportResult: (i: unknown) => Promise<unknown> }).reportResult({ taskId: 't1' })
  await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
```

### Lifecycle hooks as test seams

```ts
import type { Conn } from '@super-line/server'

it('observes connect / disconnect / errors via hooks', async () => {
  const events: string[] = []
  let captured: Conn | undefined
  const { srv, url } = await h.server(api, {
    authenticate: () => ({ role: 'user' as const, ctx: { id: 'u1' } }),
    onConnection: (conn) => { captured = conn; events.push('connect') },
    onDisconnect: () => events.push('disconnect'),
    onError: (err) => events.push(`error:${(err as SocketError).code}`),
  })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => { throw new SocketError('FORBIDDEN') } } })

  const client = h.client(api, { url, role: 'user', reconnect: false })
  await client.echo({ text: 'x' })
  expect(events).toContain('connect')
  expect(captured?.role).toBe('user')          // the captured server-side conn carries role + ctx

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
      return { role: 'user' as const, ctx: {} }
    },
    onConnection: () => { connects++ },
  })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })

  // reconnect:false so the failure surfaces immediately (a 401 looks like any drop over the WS API)
  const client = h.client(api, { url, role: 'user', params: { token: 'bad' }, reconnect: false })
  await expect(client.echo({ text: 'x' })).rejects.toMatchObject({ code: 'DISCONNECTED' })
  expect(connects).toBe(0)
})
```

### Topics: authorize + deliver

```ts
it('denies an unauthorized subscribe and delivers an authorized one', async () => {
  const { srv, url } = await h.server(api, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    authorizeSubscribe: (topic) => topic !== 'secret',
  })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })
  const client = h.client(api, { url, role: 'user' })

  await expect(client.subscribe('secret', () => {}).ready).rejects.toMatchObject({ code: 'FORBIDDEN' })

  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready
  srv.forRole('user').publish('feed', { n: 1 })
  await waitFor(() => got.length === 1)
})
```

### Reconnect: simulate a drop with `conn.ws.terminate()`

```ts
import type { Conn } from '@super-line/server'

it('auto-reconnects, re-subscribes, and rejects in-flight on drop', async () => {
  let last: Conn | undefined
  const { srv, url } = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), onConnection: (c) => { last = c } })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: () => new Promise<never>(() => {}) /* hangs */ } })
  const client = h.client(api, { url, role: 'user', reconnectBaseMs: 10, reconnectMaxMs: 50 })

  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready

  const inflight = client.boom({})              // never resolves server-side
  await tick(20)                                // ensure it's sent
  const first = last
  first!.ws.terminate()                         // simulate a network drop

  await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' })   // in-flight rejects
  await waitFor(() => last !== first && client.connected, 3000)            // reconnected (new conn)
  srv.forRole('user').publish('feed', { n: 1 })
  await waitFor(() => got.length === 1, 3000)                              // topic auto-re-subscribed
})
```

### Cross-node without Redis (shared in-memory bus)

```ts
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'

it('fans out across two nodes sharing one bus', async () => {
  const bus = new MemoryBus()
  const a = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
  const b = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
  for (const n of [a, b]) n.srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })

  const client = h.client(api, { url: a.url, role: 'user' })  // connected to node A only
  const got: number[] = []
  await client.subscribe('feed', (p) => got.push(p.n)).ready
  b.srv.forRole('user').publish('feed', { n: 7 })             // published on node B
  await waitFor(() => got.length === 1)                       // received on node A
})
```

### Cluster event bus across nodes

`server.subscribe` fires on **every** node for a publish — the origin node via in-process local echo (no Redis hop), peers via the adapter. Assert each listener fires exactly once; self-exclude with `meta.from`.

```ts
// busApi: shared.serverToClient.rebalance = { payload: z.object({ shard: z.number() }), subscribe: true }

it('one publish fires server.subscribe on both nodes exactly once', async () => {
  const bus = new MemoryBus()
  const a = await h.server(busApi, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
  const b = await h.server(busApi, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })

  const aGot: unknown[] = [], bGot: unknown[] = []
  a.srv.subscribe('rebalance', (d, { from }) => { expect(from).toBe(a.srv.nodeId); aGot.push(d) }) // origin: local echo, in-process
  b.srv.subscribe('rebalance', (d, { from }) => { expect(from).toBe(a.srv.nodeId); bGot.push(d) }) // peer: over the bus, inbound-validated
  a.srv.publish('rebalance', { shard: 3 })

  await waitFor(() => aGot.length === 1 && bGot.length === 1)
  await tick(30)
  expect(aGot).toEqual([{ shard: 3 }])             // origin fired once (no duplicate from a Redis round-trip)
  expect(bGot).toEqual([{ shard: 3 }])
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

const { Provider, useRequest } = createSocketReact<typeof api, 'user'>()
const h = createHarness()
afterEach(() => { cleanup(); return h.dispose() })

it('useRequest performs a typed call and exposes state', async () => {
  const { srv, url } = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }) })
  srv.implement({ user: { echo: async ({ text }) => ({ text }), boom: async () => ({ ok: true }) } })
  const client = h.client(api, { url, role: 'user' })

  const wrapper = ({ children }: { children: ReactNode }) => createElement(Provider, { client, children })
  const { result } = renderHook(() => useRequest('echo'), { wrapper })

  await act(async () => { await result.current.call({ text: 'hi' }) })
  expect(result.current.data).toEqual({ text: 'hi' })
  expect(result.current.isLoading).toBe(false)
})
```

### Tips

- **Close the client before the server** — an open connection blocks `server.close()` (the harness handles this via `unshift`).
- **Return `role` as a literal** from `authenticate` (`role: 'user' as const`) so it's inferred as the role key, not widened to `string`.
- `backoffDelay` is a **pure function** — unit-test it directly (no timers or sockets): `expect(backoffDelay(0, opts)).toBeLessThanOrEqual(opts.maxMs)`.
- Prefer a small `reconnectBaseMs` + `waitFor` over fake timers — `vi.useFakeTimers()` is brittle alongside real sockets (real I/O isn't faked).
- For **real cross-process** tests, use `testcontainers` + `createRedisAdapter(url)`, and skip cleanly when Docker is absent (`describe.skipIf`). For a cross-node **room** broadcast, `room.add → adapter.subscribe` is fire-and-forget, so poll the broadcast until it lands (the SUBSCRIBE-propagation window is a non-issue in real apps).
```
