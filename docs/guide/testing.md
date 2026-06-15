# Testing

The most reliable way to test super-line is over a **real loopback server** — boot a server on an ephemeral port and connect a real client, so you exercise the actual handshake, frames, and validation. The lifecycle hooks (`onConnection`/`onDisconnect`/`onError`) double as observation seams. Examples use [Vitest](https://vitest.dev).

## A tiny harness

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
    cleanups.unshift(() => c.close()) // clients close BEFORE the servers they connect to
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

## Round-trip + typed error

```ts
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

## Role enforcement

```ts
it('rejects a cross-role call with NOT_FOUND', async () => {
  const user = h.client(api, { url, role: 'user' })
  // bypass the typed surface to prove the runtime boundary
  const call = (user as unknown as { reportResult: (i: unknown) => Promise<unknown> }).reportResult({ taskId: 't1' })
  await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' })
})
```

## Hooks as seams + simulating a drop

`onConnection` captures the server-side `conn`; `conn.ws.terminate()` simulates a network drop:

```ts
let last: Conn | undefined
const { srv, url } = await h.server(api, {
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  onConnection: (c) => { last = c },
})
srv.implement({ user: { hang: () => new Promise<never>(() => {}) } })
const client = h.client(api, { url, role: 'user', reconnectBaseMs: 10 })

const inflight = client.hang({})
await tick(20)
last!.ws.terminate()
await expect(inflight).rejects.toMatchObject({ code: 'DISCONNECTED' }) // in-flight rejects
```

## Cross-node without Redis

Share one `MemoryBus` across two servers to simulate nodes — no Docker needed:

```ts
import { MemoryBus, createInMemoryAdapter } from '@super-line/server'

const bus = new MemoryBus()
const a = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
const b = await h.server(api, { authenticate: () => ({ role: 'user' as const, ctx: {} }), adapter: createInMemoryAdapter(bus) })
// publish on b, assert a subscriber on a receives it
```

For **real cross-process** tests use `testcontainers` + `createRedisAdapter(url)`, and skip cleanly when Docker is absent (`describe.skipIf`).

## React hooks

Render hooks against a real client with `renderHook` (jsdom):

```ts
const { Provider, useRequest } = createSocketReact<typeof api, 'user'>()
const wrapper = ({ children }) => createElement(Provider, { client, children })
const { result } = renderHook(() => useRequest('echo'), { wrapper })
await act(async () => { await result.current.call({ text: 'hi' }) })
expect(result.current.data).toEqual({ text: 'hi' })
```

## Tips

- **Close the client before the server** — an open connection blocks `server.close()` (the harness handles this via `unshift`).
- **Return `role` as a literal** (`'user' as const`) so it's inferred as the role key.
- `backoffDelay` is a pure function — unit-test it directly, no timers or sockets.
- Prefer a small `reconnectBaseMs` + `waitFor` over fake timers — real I/O isn't faked by `vi.useFakeTimers()`.

Next: [Comparison & FAQ](./comparison-faq).
