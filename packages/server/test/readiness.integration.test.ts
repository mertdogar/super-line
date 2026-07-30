import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { defineContract, type Adapter, type ConnDescriptor } from '@super-line/core'
import { MemoryBus, createInMemoryAdapter, createSuperLineServer, type SuperLinePlugin } from '@super-line/server'
import { createHarness, tick, waitFor } from './harness.js'

/**
 * Readiness: the gap between DECLARING an interest and holding it.
 *
 * Every test here makes that gap deterministic rather than hoping to lose a race — the adapter's
 * `subscribe` is delayed, and the bus underneath drops anything published to a channel whose
 * subscribe has not landed, which is what a real broker does. So each test FAILS without its fix
 * instead of merely flaking without it: the publish provably happens inside the window.
 */
const contract = defineContract({
  shared: {
    serverToClient: {
      message: { payload: z.object({ text: z.string() }) },
      announce: { payload: z.object({ n: z.number() }), subscribe: true },
    },
  },
  roles: { user: {} },
})

const SLOW = 60
const auth = () => ({ role: 'user' as const, ctx: {} })

/** A broker with a slow SUBSCRIBE. Anything published before it lands is gone — no retry, no queue. */
function slowSubscribe(inner: Adapter, ms = SLOW): Adapter {
  return {
    subscribe: async (channel) => {
      await tick(ms)
      await inner.subscribe(channel)
    },
    unsubscribe: (channel) => inner.unsubscribe(channel),
    publish: (channel, payload) => inner.publish(channel, payload),
    onMessage: (handler) => inner.onMessage(handler),
    close: () => inner.close?.(),
    presence: inner.presence,
  }
}

const h = createHarness()
afterEach(() => h.dispose())

const node = (bus: MemoryBus, slow = false) =>
  h.server(contract, {
    authenticate: auth,
    adapter: slow ? slowSubscribe(createInMemoryAdapter(bus)) : createInMemoryAdapter(bus),
  })

describe('readiness — room membership', () => {
  it('room.add resolves once the channel is established, so ONE broadcast is enough', async () => {
    const bus = new MemoryBus()
    const a = await node(bus, true)
    const b = await node(bus)

    const got: Array<{ text: string }> = []
    const client = h.client(contract, { url: a.url, role: 'user' })
    client.on('message', (m) => got.push(m))
    await waitFor(() => a.srv.local.connections.length === 1, { label: 'client connected to node A' })

    // Without the fix `add` returns undefined, `await` is a no-op, and the broadcast lands inside
    // the 60ms subscribe window — dropped by the bus, with nothing to retry.
    await a.srv.room('lobby').add(a.srv.local.connections[0]!)
    b.srv.room('lobby').broadcast('message', { text: 'once' })

    await waitFor(() => got.length === 1, { label: 'one broadcast reaches a room joined via add()' })
    expect(got[0]).toEqual({ text: 'once' })
  })

  it('add on an already-held room channel resolves without another round trip', async () => {
    const bus = new MemoryBus()
    const a = await node(bus, true)
    h.client(contract, { url: a.url, role: 'user' })
    h.client(contract, { url: a.url, role: 'user' })
    await waitFor(() => a.srv.local.connections.length === 2, { label: 'two clients connected' })

    await a.srv.room('lobby').add(a.srv.local.connections[0]!) // pays for the subscribe
    const startedAt = Date.now()
    await a.srv.room('lobby').add(a.srv.local.connections[1]!) // second member: channel already held
    expect(Date.now() - startedAt).toBeLessThan(SLOW)
  })
})

describe('readiness — the cluster bus', () => {
  it('subscribe().ready gates a publish from another node', async () => {
    const bus = new MemoryBus()
    const a = await node(bus, true)
    const b = await node(bus)

    const got: unknown[] = []
    const unsub = a.srv.subscribe('announce', (d) => got.push(d))
    await unsub.ready

    b.srv.publish('announce', { n: 7 })
    await waitFor(() => got.length === 1, { label: 'bus publish reaches a ready subscriber' })
    expect(got[0]).toEqual({ n: 7 })
    unsub()
  })

  it('ready resolves immediately for a channel this node already holds', async () => {
    const bus = new MemoryBus()
    const a = await node(bus, true)
    const first = a.srv.subscribe('announce', () => {})
    await first.ready

    const startedAt = Date.now()
    const second = a.srv.subscribe('announce', () => {})
    await second.ready
    expect(Date.now() - startedAt).toBeLessThan(SLOW)
    first()
    second()
  })
})

describe('readiness — plugin channels', () => {
  it('subscribe().ready gates a publish from another node', async () => {
    const bus = new MemoryBus()
    const got: unknown[] = []
    let ready: Promise<void> | undefined
    let publish: ((d: unknown) => void) | undefined

    const listener: SuperLinePlugin = {
      name: 'probe',
      setup: (ctx) => {
        ready = ctx.channel('feed').subscribe((d) => got.push(d)).ready
      },
    }
    const speaker: SuperLinePlugin = {
      name: 'probe',
      setup: (ctx) => {
        const chan = ctx.channel('feed')
        publish = (d) => chan.publish(d)
      },
    }

    await h.server(contract, { authenticate: auth, adapter: slowSubscribe(createInMemoryAdapter(bus)), plugins: [listener] })
    await h.server(contract, { authenticate: auth, adapter: createInMemoryAdapter(bus), plugins: [speaker] })

    await ready
    publish!({ hello: 'world' })
    await waitFor(() => got.length === 1, { label: 'plugin-channel publish reaches a ready subscriber' })
    expect(got[0]).toEqual({ hello: 'world' })
  })
})

describe('readiness — the server itself', () => {
  it('srv.ready awaits a transport whose start is async', async () => {
    let listening = false
    const srv = createSuperLineServer(contract, {
      authenticate: auth,
      transports: [
        {
          start: async (): Promise<void> => {
            await tick(40)
            listening = true
          },
          stop: (): void => {},
        },
      ],
    })

    // The constructor is synchronous, so it hands back a server that is provably not listening yet.
    expect(listening).toBe(false)
    await srv.ready
    expect(listening).toBe(true)
    await srv.close()
  })

  it('srv.ready rejects when a transport fails to start', async () => {
    const srv = createSuperLineServer(contract, {
      authenticate: auth,
      transports: [{ start: () => Promise.reject(new Error('port in use')), stop: () => {} }],
    })
    await expect(srv.ready).rejects.toThrow('port in use')
    await srv.close()
  })
})

describe('readiness — a connection is reachable before it is advertised', () => {
  it('subscribes the personal channel BEFORE presence announces the conn', async () => {
    const bus = new MemoryBus()
    const inner = createInMemoryAdapter(bus)
    const order: string[] = []

    const recording: Adapter = {
      ...slowSubscribe(inner),
      subscribe: async (channel) => {
        await tick(SLOW)
        await inner.subscribe(channel)
        if (channel.startsWith('c:')) order.push('subscribe')
      },
      // Proxy rather than spread: the in-memory presence store keeps its methods on a prototype,
      // so `{...presence}` silently produces an object missing every one of them.
      presence: new Proxy(inner.presence!, {
        get: (target, prop, receiver) =>
          prop === 'set'
            ? async (d: ConnDescriptor) => {
                order.push('presence.set')
                await target.set(d)
              }
            : Reflect.get(target, prop, receiver),
      }),
    }

    const a = await h.server(contract, { authenticate: auth, adapter: recording })
    h.client(contract, { url: a.url, role: 'user' })

    await waitFor(() => order.includes('presence.set'), { label: 'the conn is announced to the cluster' })
    // Announcing first is the bug: another node reads presence, emits to `c:<id>`, and the frame is
    // dropped because nobody has subscribed that channel yet.
    expect(order).toEqual(['subscribe', 'presence.set'])
  })
})
