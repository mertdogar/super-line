import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { defineContract, type TapEvent } from '@super-line/core'
import { createInMemoryAdapter, createSuperLineServer, MemoryBus, type SuperLinePlugin } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import {
  peerContract,
  peerHash,
  type PeerAdmitted,
  type PeerJoinRequest,
  type PeerJoined,
  type PeerLeft,
  type PeerSignal,
} from '../src/index.js'
import { peer, type PeerServerOptions } from '../src/server.js'
import { tick, waitFor } from '../../core/test/wait.js'

const peerDef = peerContract({
  channels: {
    input: { schema: z.object({ x: z.number() }), reliable: false },
    events: { schema: z.object({ type: z.string() }) },
  },
})
const contract = defineContract({ roles: { tv: {}, phone: {} }, plugins: [peerDef] })
type Role = 'tv' | 'phone'

const secret = (): string => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('base64url')

const allowAll: PeerServerOptions<{ name: string }> = {
  authorizeCreate: () => true,
  authorize: ({ ctx }) => ({ info: { name: ctx.name } }),
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function node(opts: PeerServerOptions<{ name: string }>, bus?: MemoryBus) {
  const loopback = createLoopbackTransport()
  const taps: TapEvent[] = []
  const recorder: SuperLinePlugin = { name: 'recorder', onEvent: (e) => taps.push(e) }
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    authenticate: (h) => ({ role: (h.query.role ?? 'phone') as Role, ctx: { name: h.query.name ?? 'anon' } }),
    plugins: [peer(opts).plugin, recorder],
    ...(bus ? { adapter: createInMemoryAdapter(bus) } : {}),
  })
  cleanups.push(() => srv.close())
  const connect = (role: Role, name: string = role) => {
    const client = createSuperLineClient(contract, { transport: loopback.client(), role, params: { role, name } })
    cleanups.push(() => client.close())
    const got = {
      joinRequest: [] as PeerJoinRequest[],
      admitted: [] as PeerAdmitted[],
      joined: [] as PeerJoined[],
      left: [] as PeerLeft[],
      signal: [] as PeerSignal[],
    }
    client.on('peer.joinRequest', (d) => got.joinRequest.push(d))
    client.on('peer.admitted', (d) => got.admitted.push(d))
    client.on('peer.joined', (d) => got.joined.push(d))
    client.on('peer.left', (d) => got.left.push(d))
    client.on('peer.signal', (d) => got.signal.push(d))
    return { client, got }
  }
  return { srv, connect, taps }
}

async function room(n: ReturnType<typeof node>) {
  const owner = n.connect('tv')
  const ownerSecret = secret()
  const created = await owner.client.peerCreateRoom({ ownerSecret })
  return { ...owner, ownerSecret, ...created }
}

describe('peerCreateRoom', () => {
  it('returns the key derived from the secret, and re-claiming returns the same key', async () => {
    const n = node(allowAll)
    const owner = n.connect('tv')
    const ownerSecret = secret()
    const first = await owner.client.peerCreateRoom({ ownerSecret })
    expect(first.roomKey).toBe(await peerHash(ownerSecret))
    expect(first.roomKey).toHaveLength(43)
    expect(first.self).toEqual({ connId: expect.any(String), role: 'tv' })

    const again = await owner.client.peerCreateRoom({ ownerSecret })
    expect(again).toEqual(first)
    expect(n.srv.room(`peer-owner:${await peerHash(first.roomKey)}`).size).toBe(1)
  })

  it('denies by default and when authorizeCreate returns false', async () => {
    // @ts-expect-error authorizeCreate is required; a JS caller that omits it gets deny-all
    const missing = node({ authorize: () => true })
    await expect(missing.connect('tv').client.peerCreateRoom({ ownerSecret: secret() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    const seen: unknown[] = []
    const refusing = node({
      authorizeCreate: ({ creator, ctx }) => {
        seen.push({ role: creator.role, name: ctx.name })
        return false
      },
      authorize: () => true,
    })
    const bob = refusing.connect('phone', 'bob').client
    await expect(bob.peerCreateRoom({ ownerSecret: secret() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(seen).toEqual([{ role: 'phone', name: 'bob' }])
  })

  it('caps the rooms one connection owns, but still lets it re-claim one it holds', async () => {
    const n = node({ ...allowAll, maxRoomsPerConn: 2 })
    const { client } = n.connect('tv')
    const a = secret()
    await client.peerCreateRoom({ ownerSecret: a })
    await client.peerCreateRoom({ ownerSecret: secret() })
    await expect(client.peerCreateRoom({ ownerSecret: secret() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(client.peerCreateRoom({ ownerSecret: a })).resolves.toMatchObject({ roomKey: await peerHash(a) })

    const other = n.connect('tv').client
    await expect(other.peerCreateRoom({ ownerSecret: secret() })).resolves.toBeDefined()
  })
})

describe('peerCloseRoom', () => {
  it('takes the caller out of the owner room, so join requests stop reaching it and the room count frees up', async () => {
    const n = node({ ...allowAll, maxRoomsPerConn: 1 })
    const owner = await room(n)
    const ownerRoom = `peer-owner:${await peerHash(owner.roomKey)}`
    await expect(owner.client.peerCreateRoom({ ownerSecret: secret() })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(owner.client.peerCloseRoom({ ownerSecret: owner.ownerSecret })).resolves.toEqual({})
    expect(n.srv.room(ownerRoom).size).toBe(0)
    await n.connect('phone').client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    await tick(30)
    expect(owner.got.joinRequest).toEqual([])
    await expect(owner.client.peerCreateRoom({ ownerSecret: secret() })).resolves.toBeDefined()
  })

  it('removes only the calling connection, and a secret for another room changes nothing', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const other = n.connect('tv')
    await other.client.peerCreateRoom({ ownerSecret: owner.ownerSecret })
    const ownerRoom = n.srv.room(`peer-owner:${await peerHash(owner.roomKey)}`)
    expect(ownerRoom.size).toBe(2)

    await owner.client.peerCloseRoom({ ownerSecret: secret() })
    expect(ownerRoom.size).toBe(2)
    await other.client.peerCloseRoom({ ownerSecret: owner.ownerSecret })
    expect(ownerRoom.connections.map((c) => c.id)).toEqual([owner.self.connId])
  })
})

describe('peerJoin', () => {
  it('delivers the join request to the owner with the server-stamped joiner and the host info', async () => {
    const authorized: unknown[] = []
    const n = node({
      authorizeCreate: () => true,
      authorize: ({ joiner, roomKey, ctx }) => {
        authorized.push({ role: joiner.role, roomKey })
        return { info: { name: ctx.name } }
      },
    })
    const owner = await room(n)
    const phone = n.connect('phone', 'alice')
    const ticket = secret()
    const joined = await phone.client.peerJoin({ roomKey: owner.roomKey, ticket })

    expect(joined.self).toEqual({ connId: expect.any(String), role: 'phone' })
    expect(authorized).toEqual([{ role: 'phone', roomKey: owner.roomKey }])
    await waitFor(() => owner.got.joinRequest.length === 1)
    expect(owner.got.joinRequest[0]).toEqual({
      keyHash: await peerHash(owner.roomKey),
      ticket,
      joiner: { connId: joined.self.connId, role: 'phone', info: { name: 'alice' } },
    })
  })

  it('omits info when authorize returns true', async () => {
    const n = node({ authorizeCreate: () => true, authorize: () => true })
    const owner = await room(n)
    const { self } = await n.connect('phone').client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    await waitFor(() => owner.got.joinRequest.length === 1)
    expect(owner.got.joinRequest[0]!.joiner).toEqual({ connId: self.connId, role: 'phone' })
  })

  it('denies by default and when authorize returns false', async () => {
    // @ts-expect-error authorize is required; a JS caller that omits it gets deny-all
    const missing = node({ authorizeCreate: () => true })
    const owner = await room(missing)
    const p1 = missing.connect('phone').client
    await expect(p1.peerJoin({ roomKey: owner.roomKey, ticket: secret() })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const refusing = node({ authorizeCreate: () => true, authorize: async () => false })
    const owner2 = await room(refusing)
    const p2 = refusing.connect('phone').client
    await expect(p2.peerJoin({ roomKey: owner2.roomKey, ticket: secret() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await tick(30)
    expect(owner.got.joinRequest).toEqual([])
    expect(owner2.got.joinRequest).toEqual([])
  })

  it('reaches nobody when the key has no owner', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    await n.connect('phone').client.peerJoin({ roomKey: await peerHash(secret()), ticket: secret() })
    await tick(30)
    expect(owner.got.joinRequest).toEqual([])
  })
})

describe('peerAdmit', () => {
  it('sends peer.admitted with the server-stamped sender before peer.joined to each listed member', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const member = n.connect('phone', 'm')
    const joiner = n.connect('phone', 'j')
    const { self: m } = await member.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    const { self: j } = await joiner.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    n.taps.length = 0

    const members = [{ connId: m.connId, info: { name: 'm' } }]
    await owner.client.peerAdmit({
      ownerSecret: owner.ownerSecret,
      joiner: { connId: j.connId, info: { name: 'j' } },
      accept: true,
      members,
    })

    await waitFor(() => joiner.got.admitted.length === 1 && member.got.joined.length === 1)
    expect(joiner.got.admitted[0]).toEqual({ roomKey: owner.roomKey, accept: true, by: owner.self, members })
    expect(member.got.joined[0]).toEqual({ roomKey: owner.roomKey, member: { connId: j.connId, info: { name: 'j' } } })
    const order = n.taps.flatMap((e) => (e.type === 'msg.event' ? [e.name] : []))
    expect(order).toEqual(['peer.admitted', 'peer.joined'])
  })

  it('tells a rejected joiner nothing about the members and notifies no one else', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const member = n.connect('phone')
    const joiner = n.connect('phone')
    const { self: m } = await member.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    const { self: j } = await joiner.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    await owner.client.peerAdmit({
      ownerSecret: owner.ownerSecret,
      joiner: { connId: j.connId },
      accept: false,
      members: [{ connId: m.connId }],
    })
    await waitFor(() => joiner.got.admitted.length === 1)
    expect(joiner.got.admitted[0]).toEqual({ roomKey: owner.roomKey, accept: false, by: owner.self, members: [] })
    await tick(30)
    expect(member.got.joined).toEqual([])
  })

  it('cannot admit into a room whose secret the sender does not hold', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const member = n.connect('phone')
    const joiner = n.connect('phone')
    const intruder = n.connect('phone')
    const { self: m } = await member.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    const { self: j } = await joiner.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    const { self: i } = await intruder.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })

    const wrong = secret()
    await intruder.client.peerAdmit({
      ownerSecret: wrong,
      joiner: { connId: j.connId },
      accept: true,
      members: [{ connId: m.connId }],
    })
    await intruder.client.peerRemove({ ownerSecret: wrong, member: m.connId, members: [j.connId] })
    await waitFor(() => joiner.got.admitted.length === 1 && member.got.joined.length === 1)

    const forged = await peerHash(wrong)
    expect(joiner.got.admitted[0]).toMatchObject({ roomKey: forged, by: { connId: i.connId, role: 'phone' } })
    expect(member.got.joined[0]!.roomKey).toBe(forged)
    await waitFor(() => member.got.left.length === 1 && joiner.got.left.length === 1)
    expect([...member.got.left, ...joiner.got.left].every((e) => e.roomKey === forged)).toBe(true)
  })
})

describe('peerRemove', () => {
  it('sends peer.left once to each listed member and to the removed one', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const a = n.connect('phone')
    const b = n.connect('phone')
    const { self: sa } = await a.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    const { self: sb } = await b.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })

    const members = [sa.connId, sb.connId]
    await owner.client.peerRemove({ ownerSecret: owner.ownerSecret, member: sa.connId, members })
    await waitFor(() => a.got.left.length === 1 && b.got.left.length === 1)
    await tick(30)
    expect(a.got.left).toEqual([{ roomKey: owner.roomKey, member: sa.connId }])
    expect(b.got.left).toEqual([{ roomKey: owner.roomKey, member: sa.connId }])
  })
})

describe('peerSignal', () => {
  it('forwards offer, answer and candidate with a server-stamped sender', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const phone = n.connect('phone')
    const { self } = await phone.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })

    await phone.client.peerSignal({ roomKey: owner.roomKey, to: owner.self.connId, kind: 'offer', sdp: 'v=0 offer' })
    await owner.client.peerSignal({ roomKey: owner.roomKey, to: self.connId, kind: 'answer', sdp: 'v=0 answer' })
    const candidate = { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 }
    await phone.client.peerSignal({ roomKey: owner.roomKey, to: owner.self.connId, kind: 'candidate', candidate })

    await waitFor(() => owner.got.signal.length === 2 && phone.got.signal.length === 1)
    expect(owner.got.signal).toEqual([
      { roomKey: owner.roomKey, from: self, kind: 'offer', sdp: 'v=0 offer' },
      { roomKey: owner.roomKey, from: self, kind: 'candidate', candidate },
    ])
    expect(phone.got.signal).toEqual([{ roomKey: owner.roomKey, from: owner.self, kind: 'answer', sdp: 'v=0 answer' }])
  })

  it('rejects a client-supplied from instead of forwarding it', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const phone = n.connect('phone')
    const forged = { roomKey: owner.roomKey, to: owner.self.connId, kind: 'offer', sdp: 'x', from: owner.self }
    // @ts-expect-error `from` is not part of the request
    await expect(phone.client.peerSignal(forged)).rejects.toMatchObject({ code: 'VALIDATION' })
    await tick(30)
    expect(owner.got.signal).toEqual([])
  })
})

describe('schema bounds', () => {
  it('rejects malformed and oversized input', async () => {
    const n = node(allowAll)
    const owner = await room(n)
    const { client } = n.connect('phone')
    const roomKey = owner.roomKey
    const to = owner.self.connId
    const bad: Array<() => Promise<unknown>> = [
      () => client.peerCreateRoom({ ownerSecret: 'short' }),
      () => client.peerCreateRoom({ ownerSecret: `${secret().slice(0, 21)}+` }),
      () => client.peerCloseRoom({ ownerSecret: 'short' }),
      () => client.peerJoin({ roomKey: roomKey.slice(1), ticket: secret() }),
      () => client.peerJoin({ roomKey, ticket: `${secret()}A` }),
      () => client.peerSignal({ roomKey, to, kind: 'offer', sdp: 'x'.repeat(65_537) }),
      () => client.peerSignal({ roomKey, to, kind: 'candidate', candidate: { candidate: 'x'.repeat(2_049) } }),
      // @ts-expect-error a candidate signal carries a candidate, not an sdp
      () => client.peerSignal({ roomKey, to, kind: 'candidate', sdp: 'x' }),
      // @ts-expect-error unknown kind
      () => client.peerSignal({ roomKey, to, kind: 'bye' }),
      () => client.peerSignal({ roomKey, to: 'x'.repeat(129), kind: 'offer', sdp: 'x' }),
      () =>
        client.peerAdmit({
          ownerSecret: secret(),
          joiner: { connId: to },
          accept: true,
          members: Array.from({ length: 33 }, (_, i) => ({ connId: `m${i}` })),
        }),
      () =>
        client.peerAdmit({
          ownerSecret: secret(),
          joiner: { connId: to, info: { bio: 'x'.repeat(257) } },
          accept: true,
          members: [],
        }),
      () =>
        client.peerAdmit({
          ownerSecret: secret(),
          joiner: { connId: to, info: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])) },
          accept: true,
          members: [],
        }),
      () =>
        // @ts-expect-error info values are flat primitives
        client.peerAdmit({ ownerSecret: secret(), joiner: { connId: to, info: { a: { b: 1 } } }, accept: true, members: [] }),
      () =>
        client.peerRemove({ ownerSecret: secret(), member: to, members: Array.from({ length: 33 }, (_, i) => `m${i}`) }),
    ]
    for (const call of bad) await expect(call()).rejects.toMatchObject({ code: 'VALIDATION' })
    await tick(30)
    expect(owner.got.signal).toEqual([])
  })
})

describe('across two nodes on one bus', () => {
  it('carries join, admit, joined and signal between nodes', async () => {
    const bus = new MemoryBus()
    const a = node(allowAll, bus)
    const b = node(allowAll, bus)
    const owner = await room(a)
    const member = a.connect('phone', 'm')
    const joiner = b.connect('phone', 'j')

    const { self: m } = await member.client.peerJoin({ roomKey: owner.roomKey, ticket: secret() })
    const ticket = secret()
    const { self: j } = await joiner.client.peerJoin({ roomKey: owner.roomKey, ticket })
    await waitFor(() => owner.got.joinRequest.length === 2)
    expect(owner.got.joinRequest[1]).toEqual({
      keyHash: await peerHash(owner.roomKey),
      ticket,
      joiner: { connId: j.connId, role: 'phone', info: { name: 'j' } },
    })

    await owner.client.peerAdmit({
      ownerSecret: owner.ownerSecret,
      joiner: { connId: j.connId, info: { name: 'j' } },
      accept: true,
      members: [{ connId: m.connId, info: { name: 'm' } }],
    })
    await waitFor(() => joiner.got.admitted.length === 1 && member.got.joined.length === 1)
    expect(joiner.got.admitted[0]).toMatchObject({ roomKey: owner.roomKey, accept: true, by: owner.self })

    await member.client.peerSignal({ roomKey: owner.roomKey, to: j.connId, kind: 'offer', sdp: 'offer' })
    await joiner.client.peerSignal({ roomKey: owner.roomKey, to: m.connId, kind: 'answer', sdp: 'answer' })
    await waitFor(() => joiner.got.signal.length === 1 && member.got.signal.length === 1)
    expect(joiner.got.signal[0]).toEqual({ roomKey: owner.roomKey, from: m, kind: 'offer', sdp: 'offer' })
    expect(member.got.signal[0]).toEqual({ roomKey: owner.roomKey, from: j, kind: 'answer', sdp: 'answer' })

    await owner.client.peerRemove({ ownerSecret: owner.ownerSecret, member: j.connId, members: [m.connId] })
    await waitFor(() => joiner.got.left.length === 1 && member.got.left.length === 1)
  })
})
