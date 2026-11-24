import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { peerContract, peerHash, peerSecret, type PeerSignal } from '../src/index.js'
import { peer } from '../src/server.js'
import {
  peerClient,
  type PeerClientOptions,
  type PeerErrorInfo,
  type PeerJoiner,
  type PeerMemberEvent,
  type PeerRoom,
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

function setup() {
  const loopback = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    authenticate: (h) => ({ role: (h.query.role ?? 'phone') as Role, ctx: { name: h.query.name ?? 'anon' } }),
    plugins: [
      peer<{ name: string }>({ authorizeCreate: () => true, authorize: ({ ctx }) => ({ info: { name: ctx.name } }) }).plugin,
    ],
  })
  cleanups.push(() => srv.close())
  const net = createFakeNetwork()
  const raw = (name: string): Client => {
    const role: Role = name === 'tv' ? 'tv' : 'phone'
    const client = createSuperLineClient(contract, { transport: loopback.client(), role, params: { role, name } })
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
  return { net, connect, raw }
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

/** Hold matching events until released, and record every event the peer client receives. */
function gate(event: string, match: (data: unknown) => boolean = () => true) {
  let released = false
  const queued: Array<() => void> = []
  const seen: Array<{ event: string; data: unknown }> = []
  const wrap = (client: Client): Client =>
    new Proxy(client, {
      get(target, prop) {
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
    const { connect } = setup()
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
    const { connect } = setup()
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
    const { host, ra, rb } = await mesh(connect, { pingIdleMs: 20, livenessTimeoutMs: 200 })
    await tick(400)
    expect(open(host, [ra.self.id, rb.self.id]) && open(ra, [host.self.id, rb.self.id])).toBe(true)

    net.filter = (owner, _channelId, data) => (owner === 'b' ? undefined : data)
    await waitFor(() => open(host, [ra.self.id]) && open(ra, [host.self.id]), { label: 'b dropped as gone' })
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
    expect(net.connections('a').every((pc) => pc.closed)).toBe(true)
    await waitFor(() => open(host, [rb.self.id]) && open(rb, [host.self.id]))
  })
})
