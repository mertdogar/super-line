import { defineContract, eq, type SuperLineError } from '@super-line/core'
import { createSuperLineClient, type ClientErrorInfo } from '@super-line/client'
import { createSuperLineServer, type PluginContext, type SuperLinePlugin } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtCollectionsClient, crdtMemoryCollections } from '@super-line/collections-crdt-memory'
import * as z from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { waitFor } from '../../core/test/wait.js'
import { hibernatingLoopback } from './hibernating-loopback.js'

// ADR-0027: a connection is reconstructible from its snapshot. A server instance is thrown away with its
// sockets still open (a Durable Object hibernating); a fresh instance adopts them and the client never notices.

const contract = defineContract({
  collections: {
    messages: { schema: z.object({ id: z.string(), channelId: z.string(), body: z.string() }), key: 'id' },
    scenes: { schema: z.object({ title: z.string().optional() }), crdt: { mode: 'document' } },
  },
  roles: {
    user: {
      env: z.object({ token: z.string() }),
      clientToServer: {
        ping: { input: z.object({ n: z.number() }), output: z.object({ n: z.number() }) },
        joinRoom: { input: z.object({ room: z.string() }), output: z.null() },
      },
      serverToClient: {
        announce: { payload: z.object({ msg: z.string() }), subscribe: true },
      },
    },
  },
})

// Storage outlives the server instance, as Durable Object SQLite does.
interface Storage {
  rows: ReturnType<typeof memoryCollections>
  docs: ReturnType<typeof crdtMemoryCollections>
}
type Srv = ReturnType<typeof boot>
function boot(transport: ReturnType<typeof hibernatingLoopback>['server'], storage: Storage, deny = false) {
  const srv = createSuperLineServer(contract, {
    transports: [transport],
    heartbeat: { interval: 10 }, // would ping every 10ms — unless the transport owns liveness
    authorizeSubscribe: () => !deny,
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid }, env: { token: `tok-${h.query.uid}` } }),
    identify: (conn) => (conn.ctx as { uid: string }).uid,
    collections: storage.rows,
    crdtCollections: storage.docs,
    policies: {
      messages: deny ? { write: () => true } : { read: () => undefined, write: () => true },
      scenes: { read: () => !deny, write: () => true },
    },
  })
  srv.implement({
    user: {
      ping: async ({ n }) => ({ n }),
      joinRoom: async ({ room }, _ctx, conn) => {
        await srv.room(room).add(conn)
        return null
      },
    },
  })
  return srv
}

describe('hibernation wake (connection snapshot)', () => {
  const servers: Srv[] = []
  const cleanups: Array<() => void> = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) c()
    for (const s of servers.splice(0)) await s.close()
  })

  function setup(clientOpts: { keepalive?: number } = {}) {
    const loop = hibernatingLoopback()
    const storage: Storage = { rows: memoryCollections(), docs: crdtMemoryCollections() }
    const start = (deny = false) => {
      const srv = boot(loop.server, storage, deny)
      servers.push(srv)
      return srv
    }
    const first = start()
    const lifecycle: string[] = []
    const errors: Array<{ code: string; info: ClientErrorInfo }> = []
    const inbound: string[] = []
    const client = createSuperLineClient(contract, {
      plugins: [{ name: 'frames', onClientSideEvent: (e) => void (e.k === 'frame' && e.dir === 'in' && inbound.push(e.f.t)) }],
      transport: loop.client(),
      role: 'user',
      params: { uid: 'alice' },
      crdtCollections: crdtCollectionsClient(),
      onDisconnect: () => lifecycle.push('disconnect'),
      onReconnect: () => lifecycle.push('reconnect'),
      onError: (err, info) => errors.push({ code: (err as SuperLineError).code, info }),
      ...clientOpts,
    })
    cleanups.push(() => client.close())
    const hibernate = async (srv: Srv, opts: { deny?: boolean } = {}) => {
      loop.evict()
      await srv.close()
      servers.splice(servers.indexOf(srv), 1)
      const next = start(opts.deny)
      loop.wake()
      return next
    }
    return { loop, first, client, lifecycle, errors, inbound, hibernate }
  }

  it('a topic subscription resumes on a fresh server instance without the client noticing', async () => {
    const { first: a, client, lifecycle, hibernate } = setup()
    const got: string[] = []
    await client.subscribe('announce', (d) => got.push(d.msg)).ready

    const b = await hibernate(a)
    b.forRole('user').publish('announce', { msg: 'after wake' })

    await waitFor(() => got.includes('after wake'))
    expect(await client.ping({ n: 1 })).toEqual({ n: 1 })
    expect(lifecycle).toEqual([])
  })

  it('a filtered row subscription and an open document resume, both directions', async () => {
    const { first: a, client, lifecycle, hibernate } = setup()
    await a.collection('scenes').create('s1', { title: 'v1' })
    const rows = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    const seen: string[] = []
    rows.subscribe((ev) => seen.push(`${ev.type}:${ev.id}`))
    await rows.ready
    const doc = client.collection('scenes').open('s1')
    await doc.ready

    const b = await hibernate(a)
    await b.collection('messages').insert({ id: 'm1', channelId: 'general', body: 'hi' })
    await b.collection('messages').insert({ id: 'm2', channelId: 'other', body: 'not mine' })
    await waitFor(() => seen.includes('insert:m1'))
    expect(seen).not.toContain('insert:m2')

    doc.update({ title: 'v2' }) // a client write lands on the new instance
    await waitFor(async () => (await b.collection('scenes').read('s1'))?.title === 'v2')
    expect(lifecycle).toEqual([])
  })

  it('env and host-joined rooms survive the wake', async () => {
    const { first: a, client, lifecycle, hibernate } = setup()
    await client.joinRoom({ room: 'lobby' })
    await client.env.ready
    expect(a.room('lobby').size).toBe(1)

    const b = await hibernate(a)
    await waitFor(() => b.room('lobby').size === 1)
    expect(client.env.current).toEqual({ token: 'tok-alice' })
    expect(lifecycle).toEqual([])
  })

  it('a subscription the new instance refuses is reported to the client, not left silently dead', async () => {
    const { loop, first: a, client, lifecycle, errors, hibernate } = setup()
    await a.collection('scenes').create('s1', { title: 'v1' })
    await client.subscribe('announce', () => {}).ready
    await client.collection('messages').subscribe({ filter: eq('channelId', 'general') }).ready
    await client.collection('scenes').open('s1').ready

    await hibernate(a, { deny: true })

    await waitFor(() => errors.length === 3)
    expect(errors.map((e) => e.code)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
    expect(errors.map((e) => e.info).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([
      { kind: 'resubscribe', collection: 'messages' },
      { kind: 'resubscribe', collection: 'scenes', id: 's1' },
      { kind: 'resubscribe', topic: 'announce' },
    ])
    expect(loop.snapshot(loop.connectionIds()[0]!)?.frames).toEqual([]) // nothing refused stays resumable
    expect(lifecycle).toEqual([])
  })

  it('the snapshot holds only acknowledged, still-live subscribes, under the connection id', async () => {
    const { loop, client } = setup()
    const topic = client.subscribe('announce', () => {})
    await topic.ready
    const rows = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await rows.ready
    await expect(client.collection('scenes').open('missing').ready).rejects.toThrow() // refused: never recorded

    const [id] = loop.connectionIds()
    const frameTypes = () => loop.snapshot(id!)!.frames.map((f) => f.t).sort()
    expect(loop.snapshot(id!)!.auth.connectionId).toBe(id)
    expect(frameTypes()).toEqual(['csub', 'sub'])

    topic.unsubscribe()
    rows.close()
    await waitFor(() => frameTypes().length === 0)
  })

  it('a transport that owns liveness stops the server heartbeat (nothing may keep a hibernating host awake)', async () => {
    const { client, inbound } = setup()
    await client.ping({ n: 1 })
    await new Promise((r) => setTimeout(r, 100))
    expect(inbound).not.toContain('ping')
  })

  it('client keepalive: pings are answered, and a peer that stops answering is dropped and redialed', async () => {
    const { loop, client, inbound, lifecycle } = setup({ keepalive: 20 })
    await client.ping({ n: 1 })
    await waitFor(() => inbound.includes('pong'))
    expect(lifecycle).toEqual([])

    loop.silence()
    await waitFor(() => lifecycle.includes('reconnect'))
    expect(lifecycle[0]).toBe('disconnect')
  })

  it('a plugin busy token is reported to the transport until every hold is released', async () => {
    const loop = hibernatingLoopback()
    let ctx: PluginContext | undefined
    const busy: SuperLinePlugin = { name: 'busy', setup: (c) => void (ctx = c) }
    const srv = createSuperLineServer(defineContract({ roles: { user: {} } }), {
      transports: [loop.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      plugins: [busy],
    })
    servers.push(srv as unknown as Srv)
    const releaseA = ctx!.hold()
    const releaseB = ctx!.hold()
    releaseA()
    releaseA() // idempotent
    releaseB()
    expect(loop.holds).toEqual([1, 2, 1, 0])
  })
})
