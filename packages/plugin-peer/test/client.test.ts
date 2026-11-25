import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as z from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { peerContract, peerHash, peerSecret, type PeerLeft, type PeerSignal } from '../src/index.js'
import { peer } from '../src/server.js'
import {
  peerClient,
  type PeerClientOptions,
  type PeerErrorInfo,
  type PeerJoiner,
  type PeerMemberEvent,
  type PeerRoom,
  type PeerRoomState,
} from '../src/client.js'
import { tick, waitFor } from '../../core/test/wait.js'
import { createFakeNetwork } from './fake-rtc.js'

const peerDef = peerContract({
  channels: {
    input: { schema: z.object({ x: z.number() }), reliable: false },
    events: { schema: z.object({ type: z.string(), n: z.number().default(0) }) },
    blob: { schema: z.string(), maxBytes: 256 },
  },
})
const contract = defineContract({ roles: { tv: {}, phone: {} }, plugins: [peerDef] })
type Role = 'tv' | 'phone'
type Channels = typeof peerDef.channels
type Room = PeerRoom<Channels>
type Client = ReturnType<typeof createSuperLineClient<typeof contract, Role>>

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function setup(opts: { libdatachannel?: boolean } = {}) {
  const loopback = createLoopbackTransport()
  const conns = new Map<string, Conn>()
  const denied = new Set<string>()
  const order = new Map<string, string>()
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    authenticate: (h) => {
      const prefix = order.get(h.query.name ?? '')
      return {
        role: (h.query.role ?? 'phone') as Role,
        ctx: { name: h.query.name ?? 'anon' },
        ...(prefix ? { connectionId: `${prefix}-${globalThis.crypto.randomUUID()}` } : {}),
      }
    },
    onConnection: (conn) => void conns.set(conn.id, conn),
    plugins: [
      peer<{ name: string }>({
        authorizeCreate: () => true,
        authorize: ({ ctx }) => !denied.has(ctx.name) && { info: { name: ctx.name } },
      }).plugin,
    ],
  })
  cleanups.push(() => srv.close())
  const net = createFakeNetwork(opts)
  cleanups.push(async () => {
    await waitFor(() => net.connections().every((pc) => pc.closed), { label: 'every peer connection closed' })
    expect(net.leaked).toBe(0)
  })
  /** Drop a client's server connection; it reconnects under a new connection id. */
  const drop = (connId: string) => conns.get(connId)!.terminate()
  const raw = (name: string): Client => {
    const role: Role = name === 'tv' ? 'tv' : 'phone'
    const client = createSuperLineClient(contract, {
      transport: loopback.client(),
      role,
      params: { role, name },
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
    })
    cleanups.push(() => client.close())
    return client
  }
  const connect = (name: string, opts: PeerClientOptions<Channels> = {}, wrap?: (c: Client) => Client) => {
    const client = raw(name)
    const errors: Array<{ error: unknown; info: PeerErrorInfo<Channels> }> = []
    const p = peerClient(wrap ? wrap(client) : client, peerDef, {
      rtc: net.rtc(name),
      onError: (error, info) => errors.push({ error, info }),
      ...opts,
    })
    cleanups.push(() => p.close())
    return { client, p, errors }
  }
  return { srv, net, connect, raw, drop, denied, order }
}

const ownerRoom = async (room: Room) => `peer-owner:${await peerHash(room.key)}`

const foreign = (errors: Array<{ error: unknown }>) =>
  errors.filter((e) => (e.error as Error).message === 'foreign candidate').length

function states(room: Room) {
  const got: PeerRoomState[] = []
  room.onState((s) => got.push(s))
  return got
}

function closes(room: Room) {
  const got: string[] = []
  room.onClose((r) => got.push(r))
  return got
}

function fakeDocument() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    visibilityState: 'hidden',
    addEventListener(type: string, cb: () => void) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(cb))
    },
    removeEventListener(type: string, cb: () => void) {
      listeners.get(type)?.delete(cb)
    },
    dispatch(type: string) {
      for (const cb of listeners.get(type) ?? []) cb()
    },
  }
}

const open = (room: Room, ids: string[]) =>
  room.members.length === ids.length && ids.every((id) => room.members.some((m) => m.id === id && m.link === 'open'))

function events(room: Room) {
  const got: PeerMemberEvent[] = []
  room.onMember((e) => got.push(e))
  return got
}

function received<N extends 'input' | 'events' | 'blob'>(room: Room, name: N) {
  const got: Array<[unknown, string]> = []
  room.channel(name).on((msg, from) => got.push([msg, from.id]))
  return got
}

/** Hold matching events until released, record every event the peer client receives, and count its joins. */
function gate(event: string, match: (data: unknown) => boolean = () => true) {
  let released = false
  let joins = 0
  const queued: Array<() => void> = []
  const seen: Array<{ event: string; data: unknown }> = []
  const wrap = (client: Client): Client =>
    new Proxy(client, {
      get(target, prop) {
        if (prop === 'peerJoin') {
          return (input: { roomKey: string; ticket: string }) => {
            joins++
            return target.peerJoin(input)
          }
        }
        if (prop !== 'on') return Reflect.get(target, prop)
        return (ev: string, handler: (data: unknown) => void) =>
          (target.on as (e: string, h: (d: unknown) => void) => () => void)(ev, (data) => {
            seen.push({ event: ev, data })
            if (ev === event && !released && match(data)) queued.push(() => handler(data))
            else handler(data)
          })
      },
    })
  const signalsFrom = (id: string) =>
    seen.filter((s) => s.event === 'peer.signal' && (s.data as PeerSignal).from.connId === id).length
  return {
    wrap,
    seen,
    signalsFrom,
    get queued() {
      return queued.length
    },
    get joins() {
      return joins
    },
    release() {
      released = true
      for (const fn of queued.splice(0)) fn()
    },
  }
}

async function mesh(connect: ReturnType<typeof setup>['connect'], opts: PeerClientOptions<Channels> = {}) {
  const tv = connect('tv', opts)
  const a = connect('a', opts)
  const b = connect('b', opts)
  const host = await tv.p.createRoom({ accept: () => true })
  const ra = await a.p.join(host.key)
  const rb = await b.p.join(host.key)
  await waitFor(
    () =>
      open(host, [ra.self.id, rb.self.id]) && open(ra, [host.self.id, rb.self.id]) && open(rb, [host.self.id, ra.self.id]),
    { label: 'full mesh open' },
  )
  return { tv, a, b, host, ra, rb }
}

describe('create, join and admit', () => {
  it('lets only the impolite side make the first offer, so a browser never rolls one back', async () => {
    const { net, connect } = setup()
    await mesh(connect)
    const pcs = net.connections()
    expect(pcs).toHaveLength(6)
    expect(pcs.filter((pc) => pc.localDescription?.type === 'offer')).toHaveLength(3)
    expect(pcs.filter((pc) => pc.rolledBack)).toEqual([])
  })

  it('admits a joiner, opens the link and carries typed messages both ways', async () => {
    const { net, connect } = setup()
    const iceServers = [{ urls: 'stun:stun.example.org' }]
    const tv = connect('tv', { iceServers: async () => iceServers, iceTransportPolicy: 'relay' })
    const phone = connect('phone')
    const asked: PeerJoiner[] = []
    const host = await tv.p.createRoom({
      accept: (joiner) => {
        asked.push(joiner)
        return true
      },
    })
    expect(host.key).toHaveLength(43)
    const guest = await phone.p.join(host.key)

    expect(asked).toEqual([{ id: guest.self.id, role: 'phone', info: { name: 'phone' } }])
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]))
    expect(host.members).toEqual([{ id: guest.self.id, role: 'phone', info: { name: 'phone' }, link: 'open' }])
    expect(guest.members).toEqual([{ id: host.self.id, role: 'tv', link: 'open' }])
    expect(guest.self).toEqual({ id: expect.any(String), role: 'phone' })

    const [pc] = net.connections('tv')
    expect(pc!.config).toEqual({ iceServers, iceTransportPolicy: 'relay' })
    expect(net.connections('phone')[0]!.config).toEqual({})
    expect([...pc!.channels.values()].map((c) => [c.id, c.label, c.ordered, c.maxRetransmits])).toEqual([
      [0, 'control', true, null],
      [1, 'blob', true, null],
      [2, 'events', true, null],
      [3, 'input', false, 0],
    ])

    const hostInput = received(host, 'input')
    const guestEvents = received(guest, 'events')
    guest.channel('input').send({ x: 1 })
    host.channel('events').send({ type: 'start' })
    await waitFor(() => hostInput.length === 1 && guestEvents.length === 1)
    expect(hostInput).toEqual([[{ x: 1 }, guest.self.id]])
    expect(guestEvents).toEqual([[{ type: 'start', n: 0 }, host.self.id]])
    expect(tv.errors).toEqual([])
    expect(phone.errors).toEqual([])

    host.channel('events').on((msg) => expectTypeOf(msg).toEqualTypeOf<{ type: string; n: number }>())
    expectTypeOf(host.channel('events').send).parameter(0).toEqualTypeOf<{ type: string; n?: number | undefined }>()
    // @ts-expect-error the channel name is checked
    expect(() => host.channel('nope')).toThrow(SuperLineError)
    // @ts-expect-error the message type is checked
    host.channel('input').send({ x: 'one' })
  })

  it('rejects with FORBIDDEN when the creator declines', async () => {
    const { connect } = setup()
    const host = await connect('tv').p.createRoom({ accept: () => false })
    await expect(connect('phone').p.join(host.key)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(host.members).toEqual([])
  })

  it('rejects with TIMEOUT when nobody owns the key', async () => {
    const { connect } = setup()
    const phone = connect('phone', { joinTimeoutMs: 100 })
    await expect(phone.p.join(await peerHash(peerSecret()))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('refuses to create a room without crypto.subtle, as on a plain-HTTP LAN page', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const subtle = vi.spyOn(globalThis.crypto, 'subtle', 'get').mockReturnValue(undefined as never)
    try {
      await expect(tv.p.createRoom({ accept: () => true })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    } finally {
      subtle.mockRestore()
    }
    await expect(tv.p.createRoom({ accept: () => true })).resolves.toBeDefined()
  })

  it('caps the room at maxMembers, counting the creator', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    await expect(tv.p.createRoom({ accept: () => true, maxMembers: 1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const host = await tv.p.createRoom({ accept: () => true, maxMembers: 2 })
    await connect('a').p.join(host.key)
    await expect(connect('b').p.join(host.key)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(host.members).toHaveLength(1)
  })

  it('returns the held room when joining a key again, and refuses the creator its own key', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const phone = connect('phone')
    let asked = 0
    const host = await tv.p.createRoom({ accept: () => ++asked > 0 })
    const [first, second] = await Promise.all([phone.p.join(host.key), phone.p.join(host.key)])
    expect(second).toBe(first)
    expect(await phone.p.join(host.key)).toBe(first)
    expect(asked).toBe(1)
    await expect(tv.p.join(host.key)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('auto-admits a returning ticket without asking again', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const phone = connect('phone')
    let asked = 0
    const host = await tv.p.createRoom({ accept: () => ++asked > 0 })
    const guest = await phone.p.join(host.key)
    await waitFor(() => open(host, [guest.self.id]))
    guest.leave()
    await waitFor(() => host.members.length === 0)
    const again = await phone.p.join(host.key)
    expect(again).not.toBe(guest)
    await waitFor(() => open(host, [again.self.id]))
    expect(asked).toBe(1)
  })
})

describe('mesh', () => {
  it('links three members pairwise', async () => {
    const { net, connect } = setup()
    await mesh(connect)
    for (const owner of ['tv', 'a', 'b']) expect(net.connections(owner)).toHaveLength(2)
  })

  it('links a mesh through an implementation that offers on its own and answers inside setRemoteDescription', async () => {
    const { connect } = setup({ libdatachannel: true })
    const { tv, a, b, host, ra, rb } = await mesh(connect)
    const got = received(rb, 'events')
    host.channel('events').send({ type: 'hi' })
    ra.channel('events').send({ type: 'hey' })
    await waitFor(() => got.length === 2)
    expect([...tv.errors, ...a.errors, ...b.errors]).toEqual([])
  })

  it('links two joiners admitted back to back', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const a = connect('a')
    const b = connect('b')
    const host = await tv.p.createRoom({ accept: () => true })
    const [ra, rb] = await Promise.all([a.p.join(host.key), b.p.join(host.key)])
    await waitFor(
      () =>
        open(host, [ra.self.id, rb.self.id]) && open(ra, [host.self.id, rb.self.id]) && open(rb, [host.self.id, ra.self.id]),
    )
  })

  it('broadcasts with send, targets one member with to(id).send and skips a backed-up lossy link', async () => {
    const { net, connect } = setup()
    const { host, ra, rb } = await mesh(connect)
    const gotA = received(ra, 'events')
    const gotB = received(rb, 'events')
    host.channel('events').send({ type: 'all' })
    host.channel('events').to(ra.self.id).send({ type: 'only-a', n: 1 })
    await waitFor(() => gotA.length === 2 && gotB.length === 1)
    await tick(30)
    expect(gotA).toEqual([
      [{ type: 'all', n: 0 }, host.self.id],
      [{ type: 'only-a', n: 1 }, host.self.id],
    ])
    expect(gotB).toEqual([[{ type: 'all', n: 0 }, host.self.id]])

    const inputA = received(ra, 'input')
    const inputB = received(rb, 'input')
    const toA = net.connections('tv').find((pc) => pc.remote?.owner === 'a')!
    toA.channels.get(3)!.bufferedAmount = 1_000_000
    host.channel('input').send({ x: 1 })
    await waitFor(() => inputB.length === 1)
    await tick(30)
    expect(inputA).toEqual([])

    expect(() => host.channel('events').to('nobody').send({ type: 'x' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    )
    expect(() => host.channel('blob').send('x'.repeat(70_000))).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }))
    expect(() => host.channel('blob').to(ra.self.id).send('x'.repeat(70_000))).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST' }),
    )
  })
})

describe('receiving', () => {
  it('drops schema-invalid and oversized messages to onError and never delivers them', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await connect('phone').p.join(host.key)
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]))
    const events = received(host, 'events')
    const blobs = received(host, 'blob')

    guest.channel('events').send({ type: 1 } as never)
    guest.channel('blob').send('x'.repeat(300))
    guest.channel('blob').send('ok')
    guest.channel('events').send({ type: 'valid' })
    await waitFor(() => events.length === 1 && blobs.length === 1 && tv.errors.length === 2)
    expect(events).toEqual([[{ type: 'valid', n: 0 }, guest.self.id]])
    expect(blobs).toEqual([['ok', guest.self.id]])
    const [invalid, oversized] = tv.errors
    expect(invalid!.error).toMatchObject({ code: 'VALIDATION' })
    expect(invalid!.info).toMatchObject({ channel: 'events', member: { id: guest.self.id }, room: host })
    expect(oversized!.error).toMatchObject({ code: 'BAD_REQUEST' })
    expect(oversized!.info).toMatchObject({ channel: 'blob', member: { id: guest.self.id } })
  })

  it('ignores signals from a connection that is not a member', async () => {
    const { net, connect, raw } = setup()
    const tv = connect('tv')
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await connect('phone').p.join(host.key)
    await waitFor(() => open(host, [guest.self.id]))

    const outsider = raw('outsider')
    const to = host.self.id
    await outsider.peerSignal({ roomKey: host.key, to, kind: 'offer', sdp: 'fake offer pc999 1' })
    await outsider.peerSignal({ roomKey: host.key, to, kind: 'candidate', candidate: { candidate: 'candidate:pc999' } })
    await outsider.peerSignal({ roomKey: await peerHash(peerSecret()), to, kind: 'offer', sdp: 'x' })
    await tick(50)
    expect(net.connections('tv')).toHaveLength(1)
    expect(host.members.map((m) => m.id)).toEqual([guest.self.id])
    expect(tv.errors).toEqual([])
  })
})

describe('races', () => {
  it('holds a signal that beats peer.admitted and forms the link once admitted', async () => {
    const { connect, order } = setup()
    order.set('tv', 'a')
    order.set('phone', 'b')
    const tv = connect('tv')
    const held = gate('peer.admitted')
    const phone = connect('phone', {}, held.wrap)
    const host = await tv.p.createRoom({ accept: () => true })
    const joining = phone.p.join(host.key)
    await waitFor(() => held.queued === 1 && held.signalsFrom(host.self.id) > 0, { label: 'offer before admission' })
    held.release()
    const guest = await joining
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]))
  })

  it('holds a signal that beats peer.joined and forms the link once the member is known', async () => {
    const { connect, order } = setup()
    order.set('b', 'a')
    order.set('a', 'b')
    const tv = connect('tv')
    const held = gate('peer.joined')
    const a = connect('a', {}, held.wrap)
    const b = connect('b')
    const host = await tv.p.createRoom({ accept: () => true })
    const ra = await a.p.join(host.key)
    const rb = await b.p.join(host.key)
    await waitFor(() => held.queued === 1 && held.signalsFrom(rb.self.id) > 0, { label: 'offer before peer.joined' })
    expect(ra.members.map((m) => m.id)).toEqual([host.self.id])
    held.release()
    await waitFor(() => open(ra, [host.self.id, rb.self.id]) && open(rb, [host.self.id, ra.self.id]))
  })

  it('holds candidates that beat their description until it is applied', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const held = gate('peer.signal', (data) => (data as PeerSignal).kind !== 'candidate')
    const phone = connect('phone', {}, held.wrap)
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await phone.p.join(host.key)
    const early = () =>
      held.seen.filter((s) => s.event === 'peer.signal' && (s.data as PeerSignal).kind === 'candidate').length
    await waitFor(() => held.queued > 0 && early() > 0, {
      label: 'a candidate delivered ahead of its description',
    })
    held.release()
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]))
    expect(phone.errors).toEqual([])
  })
})

describe('links', () => {
  it('closes a link whose hello names someone else', async () => {
    const { net, connect } = setup()
    net.filter = (owner, channelId, data) =>
      owner === 'phone' && channelId === 0 && typeof data === 'string' && data.includes('"hello"')
        ? JSON.stringify({ ...JSON.parse(data), to: 'someone-else' })
        : data
    const tv = connect('tv')
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await connect('phone').p.join(host.key)
    await waitFor(() => host.members[0]?.link === 'failed')
    expect(host.members.map((m) => m.id)).toEqual([guest.self.id])
    expect(tv.errors.map((e) => e.error)).toEqual([expect.objectContaining({ code: 'FORBIDDEN' })])
  })

  it('marks a pair that cannot connect failed and keeps the member listed', async () => {
    const { net, connect } = setup()
    net.block('a', 'b')
    const opts = { connectTimeoutMs: 300 }
    const tv = connect('tv', opts)
    const host = await tv.p.createRoom({ accept: () => true })
    const ra = await connect('a', opts).p.join(host.key)
    const rb = await connect('b', opts).p.join(host.key)
    await waitFor(() => ra.members.find((m) => m.id === rb.self.id)?.link === 'failed')
    await waitFor(() => rb.members.find((m) => m.id === ra.self.id)?.link === 'failed')
    expect(open(host, [ra.self.id, rb.self.id])).toBe(true)
    expect(ra.members.find((m) => m.id === host.self.id)?.link).toBe('open')
  })

  it('drops a member the creator cannot reach from its own list after the connect timeout', async () => {
    const { net, connect } = setup()
    net.block('tv', 'a')
    const tv = connect('tv', { connectTimeoutMs: 300 })
    const host = await tv.p.createRoom({ accept: () => true })
    const seen = events(host)
    const ra = await connect('a', { connectTimeoutMs: 300 }).p.join(host.key)
    await waitFor(() => seen.some((e) => e.type === 'left'))
    expect(host.members).toEqual([])
    await waitFor(() => ra.members[0]?.link === 'failed')
    expect(ra.members.map((m) => m.id)).toEqual([host.self.id])
  })

  it('removes a member that goes silent after its link opened', async () => {
    const { net, connect } = setup()
    const { host, ra, rb } = await mesh(connect, { pingIdleMs: 20, livenessTimeoutMs: 200, rejoinAttempts: 0 })
    await tick(400)
    expect(open(host, [ra.self.id, rb.self.id]) && open(ra, [host.self.id, rb.self.id])).toBe(true)
    const reasons = closes(rb)

    net.filter = (owner, _channelId, data) => (owner === 'b' ? undefined : data)
    await waitFor(() => open(host, [ra.self.id]) && open(ra, [host.self.id]), { label: 'b dropped as gone' })
    await waitFor(() => reasons.length === 1, { label: 'b loses the creator and gives up re-joining' })
    expect(reasons).toEqual(['lost'])
  })
})

describe('leaving', () => {
  it('leave() says bye and the others see the member go', async () => {
    const { net, connect } = setup()
    const { b, host, ra, rb } = await mesh(connect)
    const byes: string[] = []
    net.filter = (owner, channelId, data) => {
      if (channelId === 0 && typeof data === 'string' && data.includes('"bye"')) byes.push(owner)
      return data
    }
    const reasons: string[] = []
    rb.onClose((r) => reasons.push(r))
    const seen = events(host)
    rb.leave()
    expect(reasons).toEqual(['left'])
    expect(byes).toEqual(['b', 'b'])
    await waitFor(() => open(host, [ra.self.id]) && open(ra, [host.self.id]))
    expect(seen).toEqual([{ type: 'left', member: expect.objectContaining({ id: rb.self.id }) }])
    expect(rb.members).toEqual([])
    expect(net.connections('b').every((pc) => pc.closed)).toBe(true)
    await expect(b.p.join(host.key)).resolves.not.toBe(rb)
  })

  it('kick removes the member everywhere, and only the creator may kick', async () => {
    const { connect } = setup()
    const { a, host, ra, rb } = await mesh(connect)
    await expect(rb.kick(ra.self.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const reasons: string[] = []
    ra.onClose((r) => reasons.push(r))
    await host.kick(ra.self.id)
    await waitFor(() => reasons.length === 1)
    expect(reasons).toEqual(['kicked'])
    await waitFor(() => open(host, [rb.self.id]) && open(rb, [host.self.id]))

    await expect(a.p.join(host.key)).resolves.toBeDefined()
    await waitFor(() => host.members.length === 2)
  })

  it('a kicked ticket is asked about again on re-join', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const phone = connect('phone')
    let asked = 0
    const host = await tv.p.createRoom({ accept: () => ++asked > 0 })
    const guest = await phone.p.join(host.key)
    let kicked = false
    guest.onClose(() => (kicked = true))
    await host.kick(guest.self.id)
    await waitFor(() => kicked)
    await phone.p.join(host.key)
    expect(asked).toBe(2)
  })

  it('leave() before a link opens leaves the joiner clean, and the others see it go connecting then failed', async () => {
    const { net, connect } = setup()
    const opts = { connectTimeoutMs: 200 }
    const tv = connect('tv', opts)
    const b = connect('b', opts)
    const host = await tv.p.createRoom({ accept: () => true })
    const rb = await b.p.join(host.key)
    await waitFor(() => open(host, [rb.self.id]) && open(rb, [host.self.id]))
    net.block('tv', 'phone')
    net.block('b', 'phone')
    const phone = connect('phone', opts)
    const guest = await phone.p.join(host.key)
    await waitFor(() => rb.members.some((m) => m.id === guest.self.id))
    const seen = events(rb)
    expect(guest.members.map((m) => m.link)).toEqual(['connecting', 'connecting'])

    guest.leave()
    expect(guest.members).toEqual([])
    expect(guest.state).toBe('closed')
    await waitFor(() => net.connections('phone').every((pc) => pc.closed))
    await waitFor(() => host.members.length === 1 && rb.members.find((m) => m.id === guest.self.id)?.link === 'failed')
    expect(seen).toEqual([{ type: 'link', member: expect.objectContaining({ id: guest.self.id, link: 'failed' }) }])
    await tick(250)
    expect(phone.errors).toEqual([])
  })

  it('the creator gives up its owner room on leave() and close()', async () => {
    const { srv, connect } = setup()
    const tv = connect('tv')
    const first = await tv.p.createRoom({ accept: () => true })
    const second = await tv.p.createRoom({ accept: () => true })
    expect(srv.room(await ownerRoom(first)).size).toBe(1)
    first.leave()
    await waitFor(async () => srv.room(await ownerRoom(first)).size === 0)
    expect(srv.room(await ownerRoom(second)).size).toBe(1)
    tv.p.close()
    await waitFor(async () => srv.room(await ownerRoom(second)).size === 0)
  })

  it('close() closes every link and room and rejects pending joins', async () => {
    const { net, connect } = setup()
    const { a, host, ra, rb } = await mesh(connect)
    const reasons: string[] = []
    ra.onClose((r) => reasons.push(r))
    const pendingJoin = a.p.join(await peerHash(peerSecret()))
    a.p.close()
    expect(reasons).toEqual(['closed'])
    await expect(pendingJoin).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await expect(a.p.join(host.key)).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await waitFor(() => net.connections('a').every((pc) => pc.closed))
    await waitFor(() => open(host, [rb.self.id]) && open(rb, [host.self.id]))
  })
})

describe('admission and buffering limits', () => {
  it('queues at most 8 join requests behind the one being decided and drops the rest', async () => {
    const { connect } = setup()
    const watch = gate('peer.joinRequest', () => false)
    const tv = connect('tv', {}, watch.wrap)
    let release!: () => void
    const decided = new Promise<void>((resolve) => (release = resolve))
    const host = await tv.p.createRoom({
      accept: async () => {
        await decided
        return true
      },
    })
    const joining = Promise.allSettled(
      Array.from({ length: 11 }, (_, i) => connect(`j${i}`, { joinTimeoutMs: 400 }).p.join(host.key)),
    )
    await waitFor(() => watch.seen.length === 11, { label: 'every join request reached the creator' })
    release()
    const settled = await joining
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(9)
    expect(settled.flatMap((r) => (r.status === 'rejected' ? [r.reason.code] : []))).toEqual(['TIMEOUT', 'TIMEOUT'])
  })

  async function earlySignals(fillers = 0, candidate = (i: number) => `x${i}`) {
    const { connect, raw, order } = setup()
    order.set('tv', 'a')
    order.set('phone', 'b')
    const tv = connect('tv')
    const held = gate('peer.admitted')
    const phone = connect('phone', {}, held.wrap)
    const outsiders = Array.from({ length: fillers }, (_, i) => raw(`o${i}`))
    const signals = () => held.seen.filter((s) => s.event === 'peer.signal').length
    let joinerId = ''
    const host: Room = await tv.p.createRoom({
      accept: async (joiner) => {
        joinerId = joiner.id
        await Promise.all(
          outsiders.map(async (outsider) => {
            for (let i = 0; i < 32; i++) {
              await outsider.peerSignal({ roomKey: host.key, to: joiner.id, kind: 'candidate', candidate: { candidate: candidate(i) } })
            }
          }),
        )
        await waitFor(() => signals() === outsiders.length * 32, { timeout: 10_000, label: 'every filler frame held' })
        return true
      },
    })
    const joining = phone.p.join(host.key)
    await waitFor(() => held.queued === 1 && held.signalsFrom(host.self.id) >= 3, { label: 'offer and candidates held' })
    const real = held.signalsFrom(host.self.id)
    const bogus = async (n: number, size = 0) => {
      for (let i = 0; i < n; i++) {
        const c = `bogus${i}`.padEnd(size, 'x')
        await tv.client.peerSignal({ roomKey: host.key, to: joinerId, kind: 'candidate', candidate: { candidate: c } })
      }
      await waitFor(() => held.signalsFrom(host.self.id) === real + n)
    }
    return { phone, held, real, joining, bogus }
  }

  it('holds at most 32 early signals per sender and replays them once the sender is a member', async () => {
    const { phone, held, real, joining, bogus } = await earlySignals()
    await bogus(40)
    held.release()
    await joining
    await waitFor(() => foreign(phone.errors) === 32 - real)
    await tick(30)
    expect(foreign(phone.errors)).toBe(32 - real)
  })

  it('holds the early frames of a full room: 31 other members and the creator each at their own cap', async () => {
    const { phone, held, joining, bogus } = await earlySignals(31)
    await bogus(5)
    held.release()
    const guest = await joining
    await waitFor(() => foreign(phone.errors) === 5)
    await waitFor(() => guest.members[0]?.link === 'open', { label: "the creator's held offer formed the link" })
  })

  it('holds at most 33 senders worth of early frames per key', async () => {
    const { phone, held, joining, bogus } = await earlySignals(33)
    await bogus(5)
    held.release()
    await joining
    await tick(50)
    expect(foreign(phone.errors)).toBe(0)
  })

  it('stops holding early frames once a key holds 512 KB of them', async () => {
    const { phone, held, joining, bogus } = await earlySignals(8, (i) => `${i}`.padEnd(2_048, 'x'))
    await bogus(5, 2_048)
    held.release()
    await joining
    await tick(50)
    expect(foreign(phone.errors)).toBe(0)
  })

  it('drops held frames older than the join timeout', async () => {
    const { phone, held, joining, bogus } = await earlySignals()
    await bogus(5)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 30_001)
    try {
      held.release()
    } finally {
      vi.useRealTimers()
    }
    await joining
    await tick(50)
    expect(foreign(phone.errors)).toBe(0)
  })
})

describe('reconnect and re-join', () => {
  it('the creator keeps its links across a reconnect and still admits a newcomer who links to everyone', async () => {
    const { srv, connect, drop } = setup()
    const { tv, a, b, host, ra, rb } = await mesh(connect)
    const before = host.self.id
    const seen = events(host)
    drop(before)
    await waitFor(() => host.self.id !== before, { label: 'the creator re-claimed its room under a new id' })
    expect(srv.room(await ownerRoom(host)).connections.map((c) => c.id)).toEqual([host.self.id])
    expect(open(host, [ra.self.id, rb.self.id]) && open(ra, [before, rb.self.id]) && open(rb, [before, ra.self.id])).toBe(
      true,
    )

    const rc = await connect('c').p.join(host.key)
    await waitFor(
      () =>
        open(host, [ra.self.id, rb.self.id, rc.self.id]) &&
        open(rc, [host.self.id, ra.self.id, rb.self.id]) &&
        open(ra, [before, rb.self.id, rc.self.id]) &&
        open(rb, [before, ra.self.id, rc.self.id]),
      { label: 'the newcomer linked to everyone' },
    )
    expect(seen.map((e) => e.type)).toEqual(['joined', 'link'])
    expect([ra.state, rb.state]).toEqual(['active', 'active'])
    expect([...tv.errors, ...a.errors, ...b.errors]).toEqual([])
  })

  it('a joiner re-joins under its new id without asking the creator again, and the others drop the old id', async () => {
    const { connect, drop } = setup()
    const tv = connect('tv')
    const a = connect('a')
    const watchB = gate('peer.left', () => false)
    const b = connect('b', {}, watchB.wrap)
    let asked = 0
    const host = await tv.p.createRoom({ accept: () => ++asked > 0 })
    const ra = await a.p.join(host.key)
    const rb = await b.p.join(host.key)
    await waitFor(() => open(host, [ra.self.id, rb.self.id]) && open(ra, [host.self.id, rb.self.id]))
    const old = ra.self.id
    const transitions = states(ra)
    const seen = events(host)

    drop(old)
    await waitFor(
      () =>
        ra.self.id !== old &&
        open(ra, [host.self.id, rb.self.id]) &&
        open(host, [ra.self.id, rb.self.id]) &&
        open(rb, [host.self.id, ra.self.id]),
      { label: 'mesh rebuilt under the new id' },
    )
    expect(asked).toBe(2)
    expect(transitions).toEqual(['rejoining', 'active'])
    expect(seen[0]).toEqual({ type: 'left', member: expect.objectContaining({ id: old, link: 'open' }) })
    expect(watchB.seen.some((s) => s.event === 'peer.left' && (s.data as PeerLeft).member === old)).toBe(true)

    const atHost = received(host, 'events')
    const atB = received(rb, 'events')
    ra.channel('events').send({ type: 'back' })
    await waitFor(() => atHost.length === 1 && atB.length === 1)
    expect(atHost).toEqual([[{ type: 'back', n: 0 }, ra.self.id]])
    expect(atB).toEqual([[{ type: 'back', n: 0 }, ra.self.id]])
    expect(a.errors).toEqual([])
  })

  async function withheldRejoin() {
    const { connect, drop } = setup()
    const tv = connect('tv')
    let armed = false
    const held = gate('peer.admitted', () => armed)
    const a = connect('a', { rejoinBaseMs: 20, rejoinMaxMs: 20 }, held.wrap)
    const host = await tv.p.createRoom({ accept: () => true })
    const ra = await a.p.join(host.key)
    await waitFor(() => open(host, [ra.self.id]) && open(ra, [host.self.id]))
    const old = ra.self.id
    armed = true
    drop(old)
    await waitFor(() => held.queued > 0 && host.members.some((m) => m.id !== old), { label: 're-admitted, admission withheld' })
    const fresh = host.members.find((m) => m.id !== old)!.id
    const joins = held.joins
    await waitFor(() => held.joins > joins, { label: 'still retrying' })
    return { host, ra, held, fresh }
  }

  it('stops re-joining when kicked', async () => {
    const { host, ra, held, fresh } = await withheldRejoin()
    const reasons = closes(ra)
    await host.kick(fresh)
    await waitFor(() => reasons.length === 1)
    expect(reasons).toEqual(['kicked'])
    expect(ra.state).toBe('closed')
    const joins = held.joins
    await tick(80)
    expect(held.joins).toBe(joins)
  })

  it('stops re-joining on leave()', async () => {
    const { ra, held } = await withheldRejoin()
    expect(ra.state).toBe('rejoining')
    const reasons = closes(ra)
    ra.leave()
    expect(reasons).toEqual(['left'])
    const joins = held.joins
    await tick(80)
    expect(held.joins).toBe(joins)
  })

  it('gives up and closes with lost when the creator is gone', async () => {
    const { srv, net, connect } = setup()
    const { tv, host, ra, rb } = await mesh(connect, { rejoinAttempts: 3, rejoinBaseMs: 10, rejoinMaxMs: 20 })
    const transitions = states(ra)
    const reasons = [closes(ra), closes(rb)]
    const left = events(ra)
    tv.client.close()
    for (const pc of net.connections('tv')) pc.close()
    await waitFor(() => reasons.every((r) => r.length === 1), { label: 'both joiners gave up' })
    expect(reasons).toEqual([['lost'], ['lost']])
    expect(transitions).toEqual(['rejoining', 'closed'])
    expect(left[0]).toEqual({ type: 'left', member: expect.objectContaining({ id: host.self.id }) })
    expect(srv.room(await ownerRoom(host)).size).toBe(0)
  })

  for (const how of ['leave', 'close'] as const) {
    it(`members close with ended, without re-joining, when the creator calls ${how}()`, async () => {
      const { connect } = setup()
      const tv = connect('tv')
      const watchA = gate('peer.admitted', () => false)
      const watchB = gate('peer.admitted', () => false)
      const a = connect('a', {}, watchA.wrap)
      const b = connect('b', {}, watchB.wrap)
      const host = await tv.p.createRoom({ accept: () => true })
      const ra = await a.p.join(host.key)
      const rb = await b.p.join(host.key)
      await waitFor(() => open(ra, [host.self.id, rb.self.id]) && open(rb, [host.self.id, ra.self.id]))
      const transitions = [states(ra), states(rb)]
      const reasons = [closes(ra), closes(rb)]
      const joins = [watchA.joins, watchB.joins]
      if (how === 'leave') host.leave()
      else tv.p.close()
      await waitFor(() => reasons.every((r) => r.length === 1))
      expect(reasons).toEqual([['ended'], ['ended']])
      expect(transitions).toEqual([['closed'], ['closed']])
      await tick(50)
      expect([watchA.joins, watchB.joins]).toEqual(joins)
      expect([...a.errors, ...b.errors]).toEqual([])
    })
  }

  it('an end from a member that is not the creator is ignored', async () => {
    const { net, connect } = setup()
    net.filter = (owner, channelId, data) =>
      owner === 'b' && channelId === 0 && typeof data === 'string' && data.includes('"bye"') ? '{"t":"end"}' : data
    const { host, ra, rb } = await mesh(connect)
    const reasons = closes(ra)
    rb.leave()
    await waitFor(() => open(ra, [host.self.id]))
    await tick(30)
    expect(reasons).toEqual([])
    expect(ra.state).toBe('active')
  })

  it('an admission whose creator dropped after its re-claim waits for the next re-claim', async () => {
    const { connect, drop } = setup()
    let tvClient!: Client
    const tv = connect('tv')
    tvClient = tv.client
    let armed = false
    const host = await tv.p.createRoom({
      accept: async () => {
        if (armed) {
          drop(host.self.id)
          await waitFor(() => !tvClient.connected, { label: 'the creator saw the drop' })
        }
        return true
      },
    })
    const ra = await connect('a').p.join(host.key)
    await waitFor(() => open(host, [ra.self.id]) && open(ra, [host.self.id]))
    armed = true
    const before = host.self.id
    const rb = await connect('b').p.join(host.key)
    expect(rb.self.id).not.toBe(before)
    await waitFor(() => open(host, [ra.self.id, rb.self.id]) && open(rb, [host.self.id, ra.self.id]), {
      label: 'the newcomer linked to the creator under its new id',
    })
    expect(host.self.id).not.toBe(before)
    expect(rb.members.find((m) => m.id === host.self.id)).toBeDefined()
    expect(tv.errors).toEqual([])
  })

  it('closes with refused when the server denies the re-join', async () => {
    const { connect, drop, denied } = setup()
    const { ra } = await mesh(connect)
    const reasons = closes(ra)
    denied.add('a')
    drop(ra.self.id)
    await waitFor(() => reasons.length === 1)
    expect(reasons).toEqual(['refused'])
  })

  it('re-joins when the page becomes visible and the link to the creator is not open', async () => {
    const { net, connect } = setup()
    const document = fakeDocument()
    net.block('tv', 'phone')
    const tv = connect('tv', { connectTimeoutMs: 200 })
    let asked = 0
    const host = await tv.p.createRoom({ accept: () => ++asked > 0 })
    const watch = gate('peer.admitted', () => false)
    const phone = connect('phone', { connectTimeoutMs: 200, document }, watch.wrap)
    const guest = await phone.p.join(host.key)
    await waitFor(() => guest.members[0]?.link === 'failed' && host.members.length === 0)
    net.unblock('tv', 'phone')

    const joins = watch.joins
    document.dispatch('visibilitychange')
    await tick(30)
    expect([watch.joins, guest.state]).toEqual([joins, 'active'])

    document.visibilityState = 'visible'
    document.dispatch('visibilitychange')
    await waitFor(() => open(guest, [host.self.id]) && open(host, [guest.self.id]), { label: 're-joined on visible' })
    expect(asked).toBe(1)
    expect(guest.state).toBe('active')

    const after = watch.joins
    document.dispatch('visibilitychange')
    await tick(30)
    expect(watch.joins).toBe(after)

    const byes: string[] = []
    net.filter = (owner, channelId, data) => {
      if (channelId === 0 && typeof data === 'string' && data.includes('"bye"')) byes.push(owner)
      return data
    }
    document.dispatch('pagehide')
    expect(byes).toEqual(['phone'])
  })
})
