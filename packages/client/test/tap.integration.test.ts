import { afterEach, describe, expect, it } from 'vitest'
import { defineContract, type ClientTapEvent, type Schema } from '@super-line/core'
import { createSuperLineClient, type SuperLineClientPlugin } from '@super-line/client'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'

// passthrough Standard Schema (client package has no zod dep) — validate returns the value unchanged
const s = (): Schema =>
  ({ '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } }) as unknown as Schema

// a schema that always rejects, for the inbound-validation path
const bad = (): Schema =>
  ({
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => ({ issues: [{ message: 'nope' }] }),
    },
  }) as unknown as Schema

const contract = defineContract({
  shared: {
    clientToServer: { hello: { input: s(), output: s() }, slow: { input: s(), output: s() } },
    serverToClient: { tick: { payload: s() }, room: { payload: s(), subscribe: true } },
  },
  roles: { user: {} },
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const servers: SuperLineServer<typeof contract, { role: 'user'; ctx: {} }>[] = []
const clients: { close(): void }[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
  conns.length = 0
})

/** Holds the most recent server-side connection, so a test can push to it. */
const conns: { emit(event: string, data: unknown): void }[] = []

function serve(loop: ReturnType<typeof createLoopbackTransport>) {
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    onConnection: (conn) => conns.push(conn as never),
  })
  srv.implement({
    shared: {
      hello: async () => ({ ok: true }),
      slow: () => new Promise((r) => setTimeout(() => r({ ok: true }), 5_000)),
    },
    user: {},
  })
  servers.push(srv)
  return srv
}

/** Collect the tap stream, and give the plugin back so it can be registered. */
function collector(): { events: ClientTapEvent[]; plugin: SuperLineClientPlugin } {
  const events: ClientTapEvent[] = []
  // frames carry LIVE references, so snapshot the discriminant fields we assert on immediately
  return { events, plugin: { name: 'collector', onClientSideEvent: (e) => events.push(structuredClone(e)) } }
}

const frames = (events: ClientTapEvent[], dir: 'out' | 'in') =>
  events.filter((e): e is Extract<ClientTapEvent, { k: 'frame' }> => e.k === 'frame' && e.dir === dir)
const kinds = <K extends ClientTapEvent['k']>(events: ClientTapEvent[], k: K) =>
  events.filter((e): e is Extract<ClientTapEvent, { k: K }> => e.k === k)

describe('client tap (ADR-0024)', () => {
  it('emits nothing at all when no plugin taps', async () => {
    const loop = createLoopbackTransport()
    serve(loop)
    let fired = false
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      // a plugin WITHOUT onClientSideEvent must not switch tapping on
      plugins: [{ name: 'quiet', onConnect: () => (fired = true) }],
    })
    clients.push(cl)
    await cl.hello({})
    expect(fired).toBe(true)
  })

  it('reports an outbound request frame and its inbound response', async () => {
    const loop = createLoopbackTransport()
    serve(loop)
    const { events, plugin } = collector()
    const cl = createSuperLineClient(contract, { transport: loop.client(), role: 'user', plugins: [plugin] })
    clients.push(cl)
    await cl.hello({ x: 1 })

    const out = frames(events, 'out').find((e) => e.f.t === 'req')
    expect(out).toBeDefined()
    expect(out!.f).toMatchObject({ t: 'req', m: 'hello', d: { x: 1 } })
    expect(out!.bytes).toBeGreaterThan(0)

    // the response is reported as a frame too; pairing it to the request is the READER's job,
    // which is why nothing here carries a latency or a correlation result
    const res = frames(events, 'in').find((e) => e.f.t === 'res')
    expect(res).toBeDefined()
    expect((res!.f as { i: number }).i).toBe((out!.f as { i: number }).i)
  })

  it('reports the transport opening', async () => {
    const loop = createLoopbackTransport()
    serve(loop)
    const { events, plugin } = collector()
    const cl = createSuperLineClient(contract, { transport: loop.client(), role: 'user', plugins: [plugin] })
    clients.push(cl)
    await cl.hello({})
    expect(kinds(events, 'conn').some((e) => e.phase === 'open')).toBe(true)
  })

  it('reports a request dropped by a disconnect, naming the reason', async () => {
    const loop = createLoopbackTransport()
    const srv = serve(loop)
    const { events, plugin } = collector()
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      reconnect: false,
      plugins: [plugin],
    })
    clients.push(cl)
    await cl.hello({}) // ensure connected
    const inflight = cl.slow({}).catch(() => 'rejected')
    await waitFor(() => frames(events, 'out').some((e) => (e.f as { m?: string }).m === 'slow'))
    await srv.close()
    servers.length = 0
    expect(await inflight).toBe('rejected')

    const dropped = kinds(events, 'req.dropped')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ m: 'slow', why: 'disconnected' })
  })

  it('reports a delivery that found no listener — the case with no server-side symptom', async () => {
    const loop = createLoopbackTransport()
    serve(loop)
    const { events, plugin } = collector()
    const cl = createSuperLineClient(contract, { transport: loop.client(), role: 'user', plugins: [plugin] })
    clients.push(cl)
    await cl.hello({})

    conns.at(-1)!.emit('tick', { n: 1 }) // nobody called cl.on('tick', …)
    await waitFor(() => kinds(events, 'deliver').length > 0)
    expect(kinds(events, 'deliver')[0]).toMatchObject({ kind: 'event', name: 'tick', listeners: 0 })

    cl.on('tick', () => {})
    conns.at(-1)!.emit('tick', { n: 2 })
    await waitFor(() => kinds(events, 'deliver').length > 1)
    expect(kinds(events, 'deliver')[1]).toMatchObject({ name: 'tick', listeners: 1 })
  })

  it('isolates a throwing tap and routes it to onError without failing the operation', async () => {
    const loop = createLoopbackTransport()
    serve(loop)
    const errs: string[] = []
    const cl = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      onError: (_e, info) => errs.push(info.kind),
      plugins: [
        {
          name: 'boom',
          onClientSideEvent: () => {
            throw new Error('tap exploded')
          },
        },
      ],
    })
    clients.push(cl)
    await expect(cl.hello({})).resolves.toEqual({ ok: true }) // the request still succeeds
    expect(errs).toContain('tap')
  })

  it('reports inbound validation failures', async () => {
    const strict = defineContract({
      shared: {
        clientToServer: { hello: { input: s(), output: s() } },
        serverToClient: { tick: { payload: bad() } },
      },
      roles: { user: {} },
    })
    const loop = createLoopbackTransport()
    const srv = createSuperLineServer(strict, {
      transports: [loop.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      onConnection: (conn) => conns.push(conn as never),
    })
    srv.implement({ shared: { hello: async () => ({ ok: true }) }, user: {} })
    servers.push(srv as never)

    const { events, plugin } = collector()
    const cl = createSuperLineClient(strict, {
      transport: loop.client(),
      role: 'user',
      validate: 'inbound',
      onValidationError: () => {},
      plugins: [plugin],
    })
    clients.push(cl)
    await cl.hello({})
    conns.at(-1)!.emit('tick', { n: 1 })
    await waitFor(() => kinds(events, 'validate.fail').length > 0)
    expect(kinds(events, 'validate.fail')[0]).toMatchObject({ kind: 'event', name: 'tick' })
  })
})
