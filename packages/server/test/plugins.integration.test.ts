import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WebSocket } from 'ws'
import { defineContract, defineContractPlugin, defineSurface, jsonSerializer, mergeSurfaces, SuperLineError, type TapEvent } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter, createSuperLineServer, type PluginContext, type SuperLinePlugin } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { inspector } from '@super-line/plugin-inspector'
import { connectInspector, createHarness, waitFor } from './harness.js'

// a tiny raw-ws client for a plugin-owned reserved connection (negotiated by subprotocol)
function connectReserved(
  url: string,
  subprotocol: string,
): Promise<{
  req: (m: string, d?: unknown) => Promise<unknown>
  sub: (c: string) => Promise<void>
  pubs: Array<{ c: string; d: unknown }>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, subprotocol)
    let id = 1
    const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
    const pubs: Array<{ c: string; d: unknown }> = []
    ws.on('message', (data) => {
      const f = jsonSerializer.decode(data as Buffer) as { t: string; i: number; c?: string; d?: unknown; code?: string }
      if (f.t === 'pub') return void pubs.push({ c: f.c as string, d: f.d })
      const w = waiters.get(f.i)
      if (!w) return
      waiters.delete(f.i)
      if (f.t === 'res') w.resolve(f.d)
      else if (f.t === 'err') w.reject(new Error(f.code))
    })
    const send = (frame: Record<string, unknown>): Promise<unknown> =>
      new Promise((res, rej) => {
        const i = id++
        waiters.set(i, { resolve: res, reject: rej })
        ws.send(jsonSerializer.encode({ ...frame, i }))
      })
    ws.on('open', () =>
      resolve({
        req: (m, d) => send({ t: 'req', m, d }),
        sub: (c) => send({ t: 'sub', c }).then(() => undefined),
        pubs,
        close: () => ws.close(),
      }),
    )
    ws.on('error', reject)
  })
}

const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        echo: {
          input: z.object({ text: z.string(), secret: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
})
const auth = () => ({ role: 'user' as const, ctx: {} })

const h = createHarness()
afterEach(() => h.dispose())

describe('plugin taps (phase 1 · tap dispatch)', () => {
  it('delivers live, un-redacted event refs to a plugin onEvent tap while the inspector still redacts', async () => {
    const seen: TapEvent[] = []
    const tap: SuperLinePlugin = { name: 'tap', onEvent: (e) => seen.push(e) }
    const { srv, url } = await h.server(contract, {
      authenticate: auth,
      plugins: [inspector({ redact: ['secret'] }), tap],
    })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const insp = await connectInspector(url)
    await insp.subscribeEvents()

    const u = h.client(contract, { url, role: 'user' })
    await u.echo({ text: 'hi', secret: 's3cr3t' })

    // the plugin tap sees the LIVE input object — not snapshotted, not redacted
    await waitFor(() => seen.some((e) => e.type === 'msg.request'))
    const req = seen.find((e) => e.type === 'msg.request')
    expect(req && 'input' in req ? req.input : undefined).toEqual({ text: 'hi', secret: 's3cr3t' })

    // the inspector, a consumer of the same tap, still snapshots + redacts on the wire
    await waitFor(() => insp.events.some((e) => e.type === 'msg.request'))
    const inspReq = insp.events.find((e) => e.type === 'msg.request')
    expect((inspReq?.input as { secret?: string })?.secret).toBe('[Redacted]')

    u.close()
    insp.close()
  })

  it('fires taps with no inspector enabled (pure observability plugin)', async () => {
    const seen: TapEvent[] = []
    const { srv, url } = await h.server(contract, {
      authenticate: auth,
      plugins: [{ name: 'tap', onEvent: (e) => seen.push(e) }],
    })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const u = h.client(contract, { url, role: 'user' })
    await u.echo({ text: 'hi', secret: 's3cr3t' })

    await waitFor(() => seen.some((e) => e.type === 'connect'))
    await waitFor(() => seen.some((e) => e.type === 'msg.request'))
    await waitFor(() => seen.some((e) => e.type === 'msg.response'))
    u.close()
  })

  it('throws on a duplicate plugin name', async () => {
    await expect(
      h.server(contract, {
        authenticate: auth,
        plugins: [
          { name: 'dup', onEvent: () => {} },
          { name: 'dup', onEvent: () => {} },
        ],
      }),
    ).rejects.toThrow(/duplicate plugin name: dup/i)
  })
})

describe('plugin multiplexing (phase 1 · lifecycle + middleware)', () => {
  it('fans out onConnection across host + plugins in order, isolating a throw to onError', async () => {
    const calls: string[] = []
    const errors: string[] = []
    const { srv, url } = await h.server(contract, {
      authenticate: auth,
      onConnection: () => calls.push('host'),
      onError: (e) => errors.push((e as Error).message),
      plugins: [
        { name: 'a', onConnection: () => calls.push('a') },
        {
          name: 'b',
          onConnection: () => {
            calls.push('b')
            throw new Error('b-broke')
          },
        },
        { name: 'c', onConnection: () => calls.push('c') },
      ],
    })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const u = h.client(contract, { url, role: 'user' })
    await u.echo({ text: 'x', secret: 'y' })
    await waitFor(() => calls.includes('c'))

    expect(calls).toEqual(['host', 'a', 'b', 'c']) // host first, then plugin order; b threw but c still ran
    expect(errors).toContain('b-broke') // the throw was isolated + routed to onError
    u.close()
  })

  it('lets a plugin manage room membership via ctx.room (add / size / connections / remove)', async () => {
    let ctx: PluginContext | undefined
    const plugin: SuperLinePlugin = {
      name: 'rooms',
      setup: (c) => void (ctx = c),
      onConnection: (conn) => ctx?.room('vip').add(conn),
    }
    const { srv, url } = await h.server(contract, { authenticate: auth, plugins: [plugin] })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const u = h.client(contract, { url, role: 'user' })
    await u.echo({ text: 'x', secret: 'y' })

    await waitFor(() => ctx?.room('vip').size === 1) // the plugin added the conn on connect
    const [member] = ctx!.room('vip').connections
    expect(member).toBeDefined()

    ctx!.room('vip').broadcast('ping', { hello: true }) // de-typed broadcast doesn't throw
    ctx!.room('vip').remove(member!)
    expect(ctx!.room('vip').size).toBe(0)
    u.close()
  })

  it('concatenates middleware host-first, then plugins in array order', async () => {
    const order: string[] = []
    const { srv, url } = await h.server(contract, {
      authenticate: auth,
      use: [
        async (_ctx, _info, next) => {
          order.push('host')
          await next()
        },
      ],
      plugins: [
        {
          name: 'p',
          use: [
            async (_ctx, _info, next) => {
              order.push('p1')
              await next()
            },
            async (_ctx, _info, next) => {
              order.push('p2')
              await next()
            },
          ],
        },
      ],
    })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const u = h.client(contract, { url, role: 'user' })
    await u.echo({ text: 'x', secret: 'y' })
    expect(order).toEqual(['host', 'p1', 'p2'])
    u.close()
  })

  it('a throwing plugin middleware rejects the operation', async () => {
    const { srv, url } = await h.server(contract, {
      authenticate: auth,
      plugins: [
        {
          name: 'p',
          use: [
            () => {
              throw new SuperLineError('FORBIDDEN', 'no')
            },
          ],
        },
      ],
    })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const u = h.client(contract, { url, role: 'user' })
    await expect(u.echo({ text: 'x', secret: 'y' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    u.close()
  })
})

describe('plugin context (phase 1 · setup + channel)', () => {
  it('runs setup with a context, round-trips a plugin channel locally, and disposes on close', async () => {
    let seenNodeId = ''
    let disposed = false
    const got: unknown[] = []
    const plugin: SuperLinePlugin = {
      name: 'x',
      setup: (ctx) => {
        seenNodeId = ctx.nodeId
        const ch = ctx.channel('bus')
        const off = ch.subscribe((d) => got.push(d))
        ch.publish({ hello: 1 })
        return () => {
          off()
          disposed = true
        }
      },
    }
    const { srv } = await h.server(contract, { authenticate: auth, plugins: [plugin] })
    expect(seenNodeId).toBe(srv.nodeId)
    await waitFor(() => got.length === 1)
    expect(got[0]).toEqual({ hello: 1 }) // local echo on the plugin channel
    await srv.close()
    expect(disposed).toBe(true)
  })

  it('fans a plugin channel out across nodes', async () => {
    const bus = new MemoryBus()
    const recvB: unknown[] = []
    let pubA: ((d: unknown) => void) | undefined

    await h.server(contract, {
      authenticate: auth,
      adapter: createInMemoryAdapter(bus),
      plugins: [
        {
          name: 'x',
          setup: (ctx) => {
            pubA = (d) => ctx.channel('bus').publish(d)
          },
        },
      ],
    })
    await h.server(contract, {
      authenticate: auth,
      adapter: createInMemoryAdapter(bus),
      plugins: [
        {
          name: 'x',
          setup: (ctx) => {
            ctx.channel('bus').subscribe((d, meta) => {
              if (meta.from !== ctx.nodeId) recvB.push(d) // ignore local echo; record the cross-node delivery
            })
          },
        },
      ],
    })

    pubA?.({ cross: true })
    await waitFor(() => recvB.length === 1)
    expect(recvB[0]).toEqual({ cross: true })
  })
})

const harnessSurface = defineSurface({
  clientToServer: { 'harness.ping': { input: z.void(), output: z.string() } },
})
const harnessContract = defineContract({
  roles: {
    user: mergeSurfaces(
      harnessSurface,
      defineSurface({ clientToServer: { say: { input: z.string(), output: z.string() } } }),
    ),
  },
})
const hAuth = () => ({ role: 'user' as const, ctx: {} })
const harnessPlugin = (): SuperLinePlugin<typeof harnessSurface> => ({
  name: 'harness',
  handlers: () => ({ 'harness.ping': async () => 'pong' }),
})

// Compile-time assertion (never invoked): a DIRECT createSuperLineServer call — the real public API where
// `const P` infers — subtracts the plugin-handled key from implement()'s obligation. Typechecked by `pnpm typecheck`.
function _subtractionTypeCheck(): void {
  const srv = createSuperLineServer(harnessContract, {
    transports: [],
    authenticate: hAuth,
    plugins: [harnessPlugin()],
  })
  srv.implement({ user: { say: async (t) => t } }) // OK: 'harness.ping' is subtracted (plugin-handled)
  srv.implement({
    user: {
      say: async (t) => t,
      // @ts-expect-error 'harness.ping' is plugin-handled → subtracted from implement()'s obligation
      'harness.ping': async () => 'x',
    },
  })

  // subtraction must still work with MULTIPLE plugins — a surface-carrying plugin alongside a
  // surfaceless one (the tuple's P[number] is a union; HandledKeys distributes over it).
  const multi = createSuperLineServer(harnessContract, {
    transports: [],
    authenticate: hAuth,
    plugins: [harnessPlugin(), { name: 'noop', onEvent: () => {} }],
  })
  multi.implement({ user: { say: async (t) => t } }) // OK: 'harness.ping' still subtracted despite the 2nd plugin
}
void _subtractionTypeCheck

describe('plugin handlers + typed subtraction (phase 1 · handlers)', () => {
  it('serves a plugin-provided request; implement omits the subtracted key', async () => {
    const { srv, url } = await h.server(harnessContract, { authenticate: hAuth, plugins: [harnessPlugin()] })
    // harness keeps HK=never, so cast; the real subtraction is asserted in _subtractionTypeCheck above
    srv.implement({ user: { say: async (t: string) => t } } as never)
    const u = h.client(harnessContract, { url, role: 'user' })
    const call = u as unknown as Record<string, () => Promise<string>>
    expect(await call['harness.ping']!()).toBe('pong')
    expect(await u.say('hi')).toBe('hi')
    u.close()
  })

  it('throws at implement() when a non-plugin handler is missing', async () => {
    const { srv } = await h.server(harnessContract, { authenticate: hAuth, plugins: [harnessPlugin()] })
    expect(() => srv.implement({ user: {} as never })).toThrow(/missing handler.*user\.say/i)
  })

  it('throws at implement() when the host double-implements a plugin key', async () => {
    const { srv } = await h.server(harnessContract, { authenticate: hAuth, plugins: [harnessPlugin()] })
    expect(() =>
      srv.implement({ user: { say: async (t: string) => t, 'harness.ping': async () => 'x' } as never }),
    ).toThrow(/also handled by a plugin.*harness\.ping/i)
  })

  it('throws at construction when a plugin handles a key absent from the contract (unmerged surface)', async () => {
    const bareContract = defineContract({
      roles: { user: { clientToServer: { say: { input: z.string(), output: z.string() } } } },
    })
    await expect(
      h.server(bareContract, { authenticate: hAuth, plugins: [harnessPlugin()] }),
    ).rejects.toThrow(/forget to merge its surface/i)
  })
})

// A paired plugin: its contract fragment declares the collections, its server half locks/opens them via `policies`.
// This is the auth-plugin shape in miniature — secret tables locked, a public one open, the host can't override.
const secretFrag = defineContractPlugin('secretz', {
  collections: {
    profiles: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    secrets: { schema: z.object({ id: z.string(), value: z.string() }), key: 'id' },
  },
})
const policyContract = defineContract({
  roles: { user: { clientToServer: { noop: { input: z.void(), output: z.void() } } } },
  plugins: [secretFrag],
})
const policyAuth = () => ({ role: 'user' as const, ctx: {} })
const secretPlugin: SuperLinePlugin = {
  name: 'secretz',
  policies: {
    profiles: { read: () => undefined, write: () => true }, // open: clients read + write
    secrets: {}, // locked: no read, no write — server-only (co-writer still bypasses)
  },
}

describe('plugin policies (phase 1 · row policies from a paired plugin)', () => {
  it('applies plugin-contributed policies: open collection reads/writes, locked one denies client writes', async () => {
    const { srv, url } = await h.server(policyContract, {
      authenticate: policyAuth,
      collections: memoryCollections(),
      plugins: [secretPlugin],
    })
    await srv.collection('profiles').insert({ id: 'p1', name: 'Ann' }) // co-writer, policy-free
    await srv.collection('secrets').insert({ id: 's1', value: 'top' })

    const client = h.client(policyContract, { url, role: 'user' })
    const pub = client.collection('profiles').subscribe({}) // 'profiles' typed off the plugin-merged contract
    await pub.ready
    expect(pub.rows().map((r) => r.id)).toEqual(['p1']) // open read via the plugin policy

    await client.collection('profiles').insert({ id: 'p2', name: 'Bo' }) // open write → ok
    await waitFor(() => pub.rows().length === 2)
    // the locked collection rejects a client write; deny-by-default is asserted by the plugin's `{}` policy
    await expect(client.collection('secrets').insert({ id: 'x', value: 'v' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    client.close()
  })

  it('throws when a plugin policy collides with a host policy for the same collection', async () => {
    await expect(
      h.server(policyContract, {
        authenticate: policyAuth,
        collections: memoryCollections(),
        policies: { profiles: { read: () => undefined } },
        plugins: [secretPlugin], // also policies `profiles`
      }),
    ).rejects.toThrow(/policy for collection 'profiles' collides/i)
  })

  it('throws when a plugin policies a collection no fragment declared', async () => {
    await expect(
      h.server(policyContract, {
        authenticate: policyAuth,
        collections: memoryCollections(),
        plugins: [{ name: 'bad', policies: { nope: {} } }],
      }),
    ).rejects.toThrow(/unknown collection 'nope'/i)
  })
})

const monContract = defineContract({
  roles: {
    mon: {
      clientToServer: {
        'mon.ping': { input: z.void(), output: z.string() },
        'mon.emit': { input: z.object({ n: z.number() }), output: z.null() },
      },
      serverToClient: { feed: { payload: z.object({ n: z.number() }), subscribe: true } },
    },
  },
})
const monPlugin = (): SuperLinePlugin => ({
  name: 'mon',
  connection: {
    role: 'mon',
    subprotocol: 'test.mon.v1',
    contract: monContract,
    handlers: (ctx) => ({
      'mon.ping': async () => 'pong',
      'mon.emit': async (input) => {
        ctx.channel('feed').publish(input) // publish to the plugin channel the reserved conn is bridged to
        return null
      },
    }),
  },
})

describe('plugin-owned connections (phase 2)', () => {
  it('negotiates a reserved conn, serves its parallel contract, and bridges topics to a plugin channel', async () => {
    const { srv, url } = await h.server(contract, { authenticate: auth, plugins: [monPlugin()] })
    srv.implement({ user: { echo: async () => ({ ok: true }) } })

    const mon = await connectReserved(url, 'test.mon.v1')
    expect(await mon.req('mon.ping')).toBe('pong') // dispatched against the parallel contract
    await mon.sub('feed')
    await mon.req('mon.emit', { n: 42 })
    await waitFor(() => mon.pubs.some((p) => p.c === 'feed'))
    expect(mon.pubs.find((p) => p.c === 'feed')?.d).toEqual({ n: 42 })

    // observer-invisible: a normal client is the only counted connection
    const u = h.client(contract, { url, role: 'user' })
    await u.echo({ text: 'x', secret: 'y' })
    await waitFor(() => srv.local.connections.length === 1)
    expect(srv.local.connections).toHaveLength(1) // the 'mon' conn is excluded

    mon.close()
    u.close()
  })

  it('throws when a plugin reserved role collides with a contract role', async () => {
    await expect(
      h.server(contract, {
        authenticate: auth,
        plugins: [{ name: 'bad', connection: { role: 'user', contract: monContract } }],
      }),
    ).rejects.toThrow(/reserved role 'user' collides/i)
  })
})
