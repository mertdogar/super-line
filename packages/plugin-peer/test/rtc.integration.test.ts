// The client half against a real WebRTC stack: node-datachannel's polyfill (libdatachannel) on
// localhost host candidates, with super-line over loopback for signaling. A link costs ~1s here
// (libdatachannel's first DTLS flight is lost and retransmitted after 999ms), so link waits get a
// 10s ceiling.
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { build } from 'tsup'
import { RTCPeerConnection as Polyfill } from 'node-datachannel/polyfill'
import { defineContract, SuperLineError, type Serializer } from '@super-line/core'
import { createSuperLineServer, type Conn } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { peerContract } from '../src/index.js'
import { peer } from '../src/server.js'
import { peerClient, type PeerClientOptions, type PeerErrorInfo, type PeerRoom } from '../src/client.js'
import { tick, waitFor } from '../../core/test/wait.js'

const peerDef = peerContract({
  channels: {
    input: { schema: z.object({ x: z.number() }), reliable: false },
    events: { schema: z.object({ type: z.string(), n: z.number().default(0) }) },
    bytes: { schema: z.instanceof(Uint8Array) },
    blob: { schema: z.string(), maxBytes: 1_000_000 },
  },
})
const contract = defineContract({ roles: { tv: {}, phone: {} }, plugins: [peerDef] })
type Role = 'tv' | 'phone'
type Channels = typeof peerDef.channels
type Room = PeerRoom<Channels>

const LINK = { timeout: 10_000 }

const binary: Serializer = {
  encode: (value) => (value instanceof Uint8Array ? value : JSON.stringify(value)),
  decode: (data) => (typeof data === 'string' ? JSON.parse(data) : data),
}

class Tracked extends Polyfill {
  static all: Tracked[] = []
  readonly channels: Array<{ dc: RTCDataChannel; init: RTCDataChannelInit; closed: boolean }> = []
  closedLocally = false
  rolledBack = false

  constructor(
    readonly owner: string,
    config?: RTCConfiguration,
  ) {
    super(config)
    Tracked.all.push(this)
  }

  override createDataChannel(label: string, init: RTCDataChannelInit = {}) {
    const dc = super.createDataChannel(label, init)
    const entry = { dc: dc as unknown as RTCDataChannel, init, closed: false }
    const close = dc.close.bind(dc)
    dc.close = () => {
      entry.closed = true
      close()
    }
    this.channels.push(entry)
    return dc
  }

  override async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    if (desc.type === 'offer' && this.signalingState === 'have-local-offer') this.rolledBack = true
    return super.setRemoteDescription(desc)
  }

  override close() {
    this.closedLocally = true
    super.close()
  }

  /** Swallow every send from here on: the member goes silent without closing anything. */
  mute() {
    for (const { dc } of this.channels) dc.send = () => {}
  }
}

const rtcFor = (owner: string) =>
  class extends Tracked {
    constructor(config?: RTCConfiguration) {
      super(owner, config)
    }
  } as unknown as typeof RTCPeerConnection

const pcs = (owner: string) => Tracked.all.filter((pc) => pc.owner === owner)

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  const done = (c: Tracked['channels'][number]) => c.closed || c.dc.readyState === 'closed'
  await waitFor(() => Tracked.all.every((pc) => pc.closedLocally && pc.channels.every(done)), {
    timeout: 5_000,
    label: 'every peer connection and data channel closed locally',
  })
  Tracked.all = []
})

function setup() {
  const loopback = createLoopbackTransport()
  const conns = new Map<string, Conn>()
  const srv = createSuperLineServer(contract, {
    transports: [loopback.server],
    authenticate: (h) => ({ role: (h.query.role ?? 'phone') as Role, ctx: { name: h.query.name ?? 'anon' } }),
    onConnection: (conn) => void conns.set(conn.id, conn),
    plugins: [
      peer<{ name: string }>({ authorizeCreate: () => true, authorize: ({ ctx }) => ({ info: { name: ctx.name } }) })
        .plugin,
    ],
  })
  cleanups.push(() => srv.close())
  const drop = (connId: string) => conns.get(connId)!.terminate()
  const connect = (name: string, opts: PeerClientOptions<Channels> = {}) => {
    const role: Role = name === 'tv' ? 'tv' : 'phone'
    const client = createSuperLineClient(contract, {
      transport: loopback.client(),
      role,
      params: { role, name },
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
    })
    cleanups.push(() => client.close())
    const errors: Array<{ error: unknown; info: PeerErrorInfo<Channels> }> = []
    const p = peerClient(client, peerDef, {
      rtc: rtcFor(name),
      onError: (error, info) => errors.push({ error, info }),
      ...opts,
    })
    cleanups.push(() => p.close())
    return { client, p, errors }
  }
  return { connect, drop }
}

const open = (room: Room, ids: string[]) =>
  room.members.length === ids.length && ids.every((id) => room.members.some((m) => m.id === id && m.link === 'open'))

function received<N extends keyof Channels & string>(room: Room, name: N) {
  const got: Array<[unknown, string]> = []
  room.channel(name).on((msg, from) => got.push([msg, from.id]))
  return got
}

function closes(room: Room) {
  const got: string[] = []
  room.onClose((r) => got.push(r))
  return got
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
    { ...LINK, label: 'full mesh open' },
  )
  return { tv, a, b, host, ra, rb }
}

describe('real WebRTC (node-datachannel)', () => {
  it('links two members and carries typed messages both ways on a reliable and a lossy channel', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const phone = connect('phone')
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await phone.p.join(host.key)
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]), { ...LINK, label: 'link open' })

    for (const owner of ['tv', 'phone']) {
      const [pc] = pcs(owner)
      const byLabel = (label: string) => pc!.channels.find((c) => c.dc.label === label)!.dc
      expect([byLabel('input').ordered, byLabel('input').maxRetransmits]).toEqual([false, 0])
      expect([byLabel('events').ordered, byLabel('events').maxRetransmits]).toEqual([true, null])
    }

    const hostInput = received(host, 'input')
    const hostEvents = received(host, 'events')
    const guestInput = received(guest, 'input')
    const guestEvents = received(guest, 'events')
    guest.channel('input').send({ x: 1 })
    guest.channel('events').send({ type: 'press' })
    host.channel('input').send({ x: 2 })
    host.channel('events').to(guest.self.id).send({ type: 'start', n: 3 })
    await waitFor(() => hostInput.length + hostEvents.length + guestInput.length + guestEvents.length === 4)
    expect(hostInput).toEqual([[{ x: 1 }, guest.self.id]])
    expect(hostEvents).toEqual([[{ type: 'press', n: 0 }, guest.self.id]])
    expect(guestInput).toEqual([[{ x: 2 }, host.self.id]])
    expect(guestEvents).toEqual([[{ type: 'start', n: 3 }, host.self.id]])
    expect([...tv.errors, ...phone.errors]).toEqual([])
  })

  it('carries binary payloads byte for byte through a binary serializer', async () => {
    const { connect } = setup()
    const tv = connect('tv', { serializer: binary })
    const phone = connect('phone', { serializer: binary })
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await phone.p.join(host.key)
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]), { ...LINK, label: 'link open' })
    const bytes = received(host, 'bytes')
    const events = received(host, 'events')
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    guest.channel('bytes').send(all)
    guest.channel('bytes').send(new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5))
    guest.channel('events').send({ type: 'json still works' })
    await waitFor(() => bytes.length === 2 && events.length === 1)
    expect(bytes.map(([msg]) => [...(msg as Uint8Array)])).toEqual([[...all], [1, 2, 3]])
    expect(bytes[0]![0]).toBeInstanceOf(Uint8Array)
    expect(events).toEqual([[{ type: 'json still works', n: 0 }, guest.self.id]])
    expect([...tv.errors, ...phone.errors]).toEqual([])
  })

  it('forms a full mesh of three and broadcasts to every open link', async () => {
    const { connect } = setup()
    const { tv, a, b, host, ra, rb } = await mesh(connect)
    expect([pcs('tv').length, pcs('a').length, pcs('b').length]).toEqual([2, 2, 2])
    const atA = received(ra, 'events')
    const atB = received(rb, 'events')
    const atHost = received(host, 'events')
    host.channel('events').send({ type: 'from tv' })
    ra.channel('events').send({ type: 'from a' })
    await waitFor(() => atA.length === 1 && atB.length === 2 && atHost.length === 1)
    expect(atB.map(([msg, from]) => [(msg as { type: string }).type, from]).sort()).toEqual(
      [
        ['from a', ra.self.id],
        ['from tv', host.self.id],
      ].sort(),
    )
    expect([...tv.errors, ...a.errors, ...b.errors]).toEqual([])
  })

  it('links simultaneous joiners: every pair collides and the polite side rolls its offer back', async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const joiners = ['a', 'b', 'c', 'd'].map((name) => connect(name))
    const host = await tv.p.createRoom({ accept: () => true })
    const rooms = await Promise.all(joiners.map((j) => j.p.join(host.key)))
    const everyone = [host, ...rooms]
    const ids = everyone.map((r) => r.self.id)
    await waitFor(() => everyone.every((r) => open(r, ids.filter((id) => id !== r.self.id))), {
      ...LINK,
      label: 'five-member mesh open',
    })
    expect(Tracked.all).toHaveLength(20)
    expect(Tracked.all.filter((pc) => pc.rolledBack)).toHaveLength(10)
    expect([...tv.errors, ...joiners.flatMap((j) => j.errors)]).toEqual([])
  })

  it('drops a member whose peer connections die at once', async () => {
    const { connect } = setup()
    const { host, ra, rb } = await mesh(connect, { rejoinAttempts: 0 })
    const gone = rb.self.id
    const started = Date.now()
    for (const pc of pcs('b')) pc.close()
    await waitFor(() => open(host, [ra.self.id]) && open(ra, [host.self.id]), { label: 'b dropped' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(host.members.some((m) => m.id === gone)).toBe(false)
  })

  it('drops a member that goes silent within the liveness timeout', async () => {
    const { connect } = setup()
    const { host, ra, rb } = await mesh(connect, { rejoinAttempts: 0 })
    const gone = rb.self.id
    const dropped: number[] = []
    for (const room of [host, ra]) room.onMember((e) => e.type === 'left' && e.member.id === gone && dropped.push(Date.now()))
    for (const pc of pcs('b')) pc.mute()
    const started = Date.now()
    await waitFor(() => dropped.length === 2, { timeout: 6_000, label: 'b dropped as gone by both' })
    for (const at of dropped) {
      expect(at - started).toBeGreaterThanOrEqual(2_000)
      expect(at - started).toBeLessThan(4_500)
    }
  })

  it('a joiner re-joins under its new id after its server connection drops and relinks everyone', async () => {
    const { connect, drop } = setup()
    const { a, host, ra, rb } = await mesh(connect)
    const old = ra.self.id
    drop(old)
    await waitFor(
      () =>
        ra.self.id !== old &&
        ra.state === 'active' &&
        open(ra, [host.self.id, rb.self.id]) &&
        open(host, [ra.self.id, rb.self.id]) &&
        open(rb, [host.self.id, ra.self.id]),
      { ...LINK, label: 'mesh rebuilt under the new id' },
    )
    const atHost = received(host, 'events')
    const atB = received(rb, 'events')
    ra.channel('events').send({ type: 'back' })
    await waitFor(() => atHost.length === 1 && atB.length === 1)
    expect(atHost).toEqual([[{ type: 'back', n: 0 }, ra.self.id]])
    expect(atB).toEqual([[{ type: 'back', n: 0 }, ra.self.id]])
    expect(a.errors).toEqual([])
  })

  it("refuses a message over the link's maxMessageSize with a typed error and carries one under it", async () => {
    const { connect } = setup()
    const tv = connect('tv')
    const phone = connect('phone')
    const host = await tv.p.createRoom({ accept: () => true })
    const guest = await phone.p.join(host.key)
    await waitFor(() => open(host, [guest.self.id]) && open(guest, [host.self.id]), { ...LINK, label: 'link open' })
    const max = pcs('tv')[0]!.sctp!.maxMessageSize!
    expect(max).toBeGreaterThan(65_536)
    const tooBig = 'x'.repeat(max)
    const fail = (fn: () => void) => {
      try {
        fn()
      } catch (err) {
        return err
      }
      throw new Error('expected a throw')
    }
    for (const err of [
      fail(() => host.channel('blob').send(tooBig)),
      fail(() => host.channel('blob').to(guest.self.id).send(tooBig)),
    ]) {
      expect(err).toBeInstanceOf(SuperLineError)
      expect(err).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining(String(max)) })
    }
    const got = received(guest, 'blob')
    const big = 'y'.repeat(max - 1_000)
    host.channel('blob').send(big)
    await waitFor(() => got.length === 1)
    expect((got[0]![0] as string).length).toBe(big.length)
    expect([...tv.errors, ...phone.errors]).toEqual([])
  })

  for (const how of ['leave', 'close'] as const) {
    it(`members close with ended at once when the creator calls ${how}()`, async () => {
      const { connect } = setup()
      const { tv, a, b, host, ra, rb } = await mesh(connect)
      const reasons = [closes(ra), closes(rb)]
      const states: string[] = []
      ra.onState((s) => states.push(s))
      const started = Date.now()
      if (how === 'leave') host.leave()
      else tv.p.close()
      await waitFor(() => reasons.every((r) => r.length === 1), { label: 'both joiners closed' })
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(reasons).toEqual([['ended'], ['ended']])
      expect(states).toEqual(['closed'])
      await tick(100)
      expect([...a.errors, ...b.errors]).toEqual([])
    })
  }

  it('a Node process exits on its own after leave() and close()', async () => {
    const outDir = join(import.meta.dirname, '../node_modules/.cache/rtc-exit')
    await build({
      entry: { 'rtc-exit': join(import.meta.dirname, 'rtc-exit.ts') },
      outDir,
      format: ['esm'],
      platform: 'node',
      target: 'node20',
      tsconfig: join(import.meta.dirname, '../../../tsconfig.json'),
      external: ['node-datachannel'],
      noExternal: [/^(?!node-datachannel)/],
      config: false,
      silent: true,
    })
    const child = spawn(process.execPath, [join(outDir, 'rtc-exit.js')], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    const code = await new Promise<number | null>((resolve) => {
      const deadline = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null)
      }, 15_000)
      child.on('exit', (exitCode) => {
        clearTimeout(deadline)
        resolve(exitCode)
      })
    })
    expect(out).toContain('CLOSED ended')
    expect(out).toContain('DONE')
    expect(code).toBe(0)
  })
})
