// PROTOTYPE — throwaway (wayfinder T04, .scratch/cloudflare-workers). Not part of any lane; run by hand:
//   pnpm exec vitest run packages/server/test/connection-snapshot.proto.test.ts
// Question: can a live connection's server-side state be captured, the server instance thrown away, and a
// FRESH server instance adopt the still-open socket so the client never notices? (= DO hibernation wake.)
// Approach: the snapshot is {AuthOutcome, the client's live subscribe frames}; adopt = acceptConn + replay with acks muted.
import { defineContract, eq, and } from '@super-line/core'
import type { RawConn, ServerTransport, ClientTransport, AuthOutcome, ClientFrame } from '@super-line/core'
import { createSuperLineClient } from '@super-line/client'
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import * as z from 'zod'
import { describe, expect, it } from 'vitest'
import { waitFor } from '../../core/test/wait.js'

// ── a loopback whose server ends SURVIVE server teardown (the DO's ctx.getWebSockets()) ───────────────
interface Snapshot {
  auth: AuthOutcome
  frames: Record<string, ClientFrame> // keyed so a later unsub/cuns/cdclose cancels the subscribe
}
const dec = new TextDecoder()
const enc = new TextEncoder()
const REPLAY_BASE = 1_000_000_000

function keyOf(f: ClientFrame): [string, 'set' | 'del'] | undefined {
  if (f.t === 'sub') return [`sub:${f.c}`, 'set']
  if (f.t === 'unsub') return [`sub:${f.c}`, 'del']
  if (f.t === 'csub') return [`csub:${f.s}`, 'set']
  if (f.t === 'cuns') return [`csub:${f.s}`, 'del']
  if (f.t === 'cdopen') return [`cdopen:${f.n}:${f.id}`, 'set']
  if (f.t === 'cdclose') return [`cdopen:${f.n}:${f.id}`, 'del']
  return undefined
}

class End implements RawConn {
  writable = true
  peer!: End
  msgCb?: (b: Uint8Array) => void
  closeCb?: (code: number, reason?: string) => void
  closed = false
  evicting = false
  muteReplayAcks = false
  snapshot?: Snapshot
  constructor(private readonly fixedDeliver?: (b: Uint8Array) => void) {
    this.msgCb = fixedDeliver
  }
  send(bytes: string | Uint8Array) {
    if (!this.writable) return
    const u8 = typeof bytes === 'string' ? enc.encode(bytes) : bytes
    if (this.muteReplayAcks) {
      const f = JSON.parse(dec.decode(u8))
      if ((f.t === 'res' || f.t === 'err') && f.i >= REPLAY_BASE) return
    }
    queueMicrotask(() => this.peer.deliver(u8))
  }
  deliver(u8: Uint8Array) {
    if (this.closed) return
    if (this.snapshot) {
      // the server end records the client's subscribe frames — this IS the restorable state
      const f = JSON.parse(dec.decode(u8)) as ClientFrame
      const k = keyOf(f)
      if (k) k[1] === 'set' ? (this.snapshot.frames[k[0]] = f) : delete this.snapshot.frames[k[0]]
    }
    this.msgCb?.(u8)
  }
  onMessage(cb: (b: Uint8Array) => void) {
    this.msgCb = cb
  }
  onClose(cb: (code: number, reason?: string) => void) {
    this.closeCb = cb
  }
  onDrain() {}
  close(code = 1000, reason?: string) {
    if (this.evicting) return // DO eviction: the socket outlives the server instance
    this.closeAll(code, reason)
  }
  terminate() {
    this.close(1006)
  }
  closeAll(code: number, reason?: string) {
    for (const e of [this, this.peer]) {
      e.closed = true
      e.writable = false
    }
    this.closeCb?.(code, reason)
    this.peer.closeCb?.(code, reason)
  }
}

function hibernatingLoopback() {
  let hooks: Parameters<ServerTransport['start']>[0] | undefined
  const sockets = new Set<End>() // server ends; survive stop()
  const server: ServerTransport = {
    start: (h) => void (hooks = h),
    stop: () => void (hooks = undefined),
  }
  const client = (): ClientTransport => ({
    connect(params, ch) {
      const clientEnd = new End((b) => ch.onMessage(b))
      const serverEnd = new End()
      clientEnd.peer = serverEnd
      serverEnd.peer = clientEnd
      clientEnd.onClose((code) => ch.onClose(code))
      hooks!.authenticate({ transport: 'hib-loopback', headers: {}, query: params, raw: undefined }).then((auth) => {
        serverEnd.snapshot = { auth, frames: {} }
        sockets.add(serverEnd)
        hooks!.onConnection(serverEnd, auth)
        ch.onOpen()
      })
      return clientEnd
    },
  })
  const evict = () => {
    for (const s of sockets) s.evicting = true
  }
  // wake: a fresh server instance adopts every surviving socket from its snapshot
  const adopt = () => {
    for (const s of sockets) {
      s.evicting = false
      s.msgCb = undefined
      s.closeCb = undefined
      hooks!.onConnection(s, s.snapshot!.auth)
      s.muteReplayAcks = true
      let i = REPLAY_BASE
      for (const f of Object.values(s.snapshot!.frames)) s.msgCb!(enc.encode(JSON.stringify({ ...f, i: i++ })))
    }
  }
  const snapshots = () => [...sockets].map((s) => s.snapshot!)
  return { server, client, evict, adopt, snapshots }
}

// ── the app ───────────────────────────────────────────────────────────────────────────────────────────
const contract = defineContract({
  collections: {
    messages: { schema: z.object({ id: z.string(), channelId: z.string(), body: z.string() }), key: 'id' },
    scenes: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } },
  },
  roles: {
    user: {
      env: z.object({ token: z.string() }),
      clientToServer: {
        ping: { input: z.object({ n: z.number() }), output: z.object({ n: z.number(), uid: z.string() }) },
        joinRoom: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        announce: { payload: z.object({ msg: z.string() }), subscribe: true },
        ticker: { payload: z.object({ t: z.number() }), subscribe: true },
      },
    },
  },
})

const rows = memoryCollections()
const docs = crdtMemoryCollections()
function boot(transport: ServerTransport) {
  const srv = createSuperLineServer(contract, {
    transports: [transport],
    heartbeat: false,
    authenticate: (h) => ({
      role: 'user' as const,
      ctx: { uid: h.query.uid, claims: { sub: h.query.uid, org: 'acme', plan: 'pro' } },
      env: { token: `tok-${h.query.uid}` },
    }),
    identify: (conn) => (conn.ctx as { uid: string }).uid,
    collections: rows,
    crdtCollections: docs,
    policies: {
      messages: { read: () => undefined, write: () => true },
      scenes: { read: () => true, write: () => true },
    },
  })
  srv.implement({
    user: {
      ping: async ({ n }, ctx) => ({ n, uid: (ctx as { uid: string }).uid }),
      joinRoom: async ({ room }, _ctx, conn) => (await srv.room(room).add(conn), { ok: true }),
    },
  })
  return srv
}

describe('PROTOTYPE connection snapshot/restore (T04)', () => {
  it('a fresh server adopts a surviving socket; the client never reconnects', async () => {
    const loop = hibernatingLoopback()
    const srvA = boot(loop.server)
    await srvA.collection('scenes').create('s1', { title: 'v1' })

    const lifecycle: string[] = []
    const client = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid: 'alice' },
      crdtCollections: crdtCollectionsClient(),
      onReconnect: () => lifecycle.push('reconnect'),
      onDisconnect: () => lifecycle.push('disconnect'),
    })
    const announces: string[] = []
    const ticks: number[] = []
    await client.subscribe('announce', (d) => announces.push(d.msg)).ready
    await client.subscribe('ticker', (d) => ticks.push(d.t)).ready
    const live = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    const rowEvents: string[] = []
    live.subscribe((ev) => rowEvents.push(`${ev.type}:${ev.id}`))
    await live.ready
    const doc = client.collection('scenes').open('s1')
    await doc.ready
    await client.joinRoom({ room: 'lobby' })
    expect(await client.ping({ n: 1 })).toEqual({ n: 1, uid: 'alice' })
    expect(srvA.room('lobby').size).toBe(1)

    // ── eviction: server A dies, sockets survive ───────────────────────────────────────────────
    loop.evict()
    await srvA.close()
    const [snap] = loop.snapshots()
    const bytes = enc.encode(JSON.stringify(snap)).length
    console.log('snapshot (realistic small conn):', bytes, 'bytes', JSON.stringify(snap))

    // ── wake: server B adopts ─────────────────────────────────────────────────────────────────
    const srvB = boot(loop.server)
    loop.adopt()
    await new Promise((r) => setTimeout(r, 50))
    expect(lifecycle).toEqual([]) // no disconnect, no reconnect: the client never noticed

    // every pattern resumes on B
    srvB.forRole('user').publish('announce', { msg: 'from-B' })
    await waitFor(() => announces.includes('from-B'))
    srvB.forRole('user').publish('ticker', { t: 7 })
    await waitFor(() => ticks.includes(7))
    await srvB.collection('messages').insert({ id: 'm1', channelId: 'general', body: 'hi' })
    await waitFor(() => rowEvents.includes('insert:m1'))
    await srvB.collection('messages').insert({ id: 'm2', channelId: 'other', body: 'filtered' })
    expect(rowEvents).not.toContain('insert:m2')
    expect(await client.ping({ n: 2 })).toEqual({ n: 2, uid: 'alice' })
    expect(srvB.room('lobby').size).toBe(0) // rooms NOT restored (handler-joined)
    expect(client.env.current).toEqual({ token: 'tok-alice' })

    // doc: a second client on B writes; alice's open doc sees it
    const bob = createSuperLineClient(contract, {
      transport: loop.client(),
      role: 'user',
      params: { uid: 'bob' },
      crdtCollections: crdtCollectionsClient(),
    })
    const bobDoc = bob.collection('scenes').open('s1')
    await bobDoc.ready
    bobDoc.update({ title: 'v2' })
    await waitFor(() => (doc.getSnapshot() as { title?: string }).title === 'v2')
    // and alice can still write
    doc.update({ title: 'v3' })
    await waitFor(() => (bobDoc.getSnapshot() as { title?: string }).title === 'v3')

    client.close()
    bob.close()
    await srvB.close()
  })

  it('size: realistic and heavy snapshots vs the 16 KiB attachment limit', () => {
    const auth: AuthOutcome = {
      role: 'user',
      transport: 'cloudflare',
      connectionId: crypto.randomUUID(),
      ctx: {
        userId: crypto.randomUUID(),
        roles: ['user', 'editor'],
        sessionId: crypto.randomUUID(),
        authMethod: 'jwt',
        authId: crypto.randomUUID(),
        claims: { sub: crypto.randomUUID(), org: 'acme-corp', plan: 'enterprise', email: 'alice@example.com', iat: 1760000000, exp: 1760086400 },
        sealed: { stripeCustomer: 'cus_' + 'x'.repeat(14), internalTier: 3 },
      },
      env: { token: 'tok_' + 'y'.repeat(40), refreshAt: 1760003600 },
    }
    const mk = (topics: number, subs: number, docsN: number) => {
      const frames: ClientFrame[] = []
      for (let i = 0; i < topics; i++) frames.push({ t: 'sub', i, c: `topic-${i}` })
      for (let i = 0; i < subs; i++)
        frames.push({
          t: 'csub',
          i,
          n: `collection${i % 8}`,
          s: i,
          q: {
            filter: and(eq('channelId', crypto.randomUUID()), eq('deleted', false), eq('kind', 'message')),
            orderBy: [{ field: 'createdAt', dir: 'desc' }],
            limit: 100,
          },
        })
      for (let i = 0; i < docsN; i++) frames.push({ t: 'cdopen', i, n: 'documents', id: crypto.randomUUID() })
      return enc.encode(JSON.stringify({ auth, frames })).length
    }
    const table = {
      'auth only': enc.encode(JSON.stringify({ auth })).length,
      'chat-like: 5 topics, 10 subs, 2 docs': mk(5, 10, 2),
      'dashboard: 10 topics, 40 subs, 5 docs': mk(10, 40, 5),
      'heavy: 20 topics, 100 subs, 50 docs': mk(20, 100, 50),
    }
    console.table(Object.entries(table).map(([k, v]) => ({ shape: k, bytes: v, 'fits 16KiB': v <= 16384 })))
    expect(table['auth only']).toBeLessThan(16384)
  })
})
