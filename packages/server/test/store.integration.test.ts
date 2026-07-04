import { jsonSerializer, defineContract, type ClientTransport, type ServerFrame } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryStoreServer } from '@super-line/store-memory'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const contract = defineContract({ roles: { user: { clientToServer: {} } } })
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

type AnyFrame = ServerFrame & Record<string, unknown>

// A raw loopback client that speaks store frames directly (the typed client store handle is slice 4).
function rawClient(transport: ClientTransport, uid: string) {
  const frames: AnyFrame[] = []
  const waiters = new Map<number, (f: AnyFrame) => void>()
  let resolveOpen!: () => void
  const opened = new Promise<void>((r) => (resolveOpen = r))
  const raw = transport.connect(
    { role: 'user', uid },
    {
      onOpen: () => resolveOpen(),
      onMessage: (b) => {
        const f = jsonSerializer.decode(b) as AnyFrame
        frames.push(f)
        const i = f.i as number | undefined
        if (typeof i === 'number') {
          waiters.get(i)?.(f)
          waiters.delete(i)
        }
      },
      onClose: () => {},
      onDrain: () => {},
    },
  )
  let id = 0
  const req = (frame: Record<string, unknown>): Promise<AnyFrame> => {
    const i = ++id
    return new Promise<AnyFrame>((resolve) => {
      waiters.set(i, resolve)
      raw.send(jsonSerializer.encode({ ...frame, i }))
    })
  }
  const changes = (): AnyFrame[] => frames.filter((f) => f.t === 'sch')
  return { opened, frames, changes, req, close: () => raw.close() }
}

function setup() {
  const loop = createLoopbackTransport()
  const srv = createSuperLineServer(contract, {
    transports: [loop.server],
    authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
    identify: (conn) => (conn.ctx as { uid?: string }).uid,
    stores: { docs: memoryStoreServer() },
  })
  return { srv, transport: loop.client() }
}

describe('store — server-side handle (srv.store)', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })
  afterEach(() => env.srv.close())

  it('create + read round-trips', async () => {
    await env.srv.store('docs').create('a', { n: 1 }, { alice: { read: true, write: true } })
    expect(await env.srv.store('docs').read('a')).toEqual({
      id: 'a',
      data: { n: 1 },
      accessRules: { alice: { read: true, write: true } },
    })
  })

  it('create on a duplicate id throws CONFLICT', async () => {
    await env.srv.store('docs').create('dup', {}, {})
    await expect(env.srv.store('docs').create('dup', {}, {})).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('write co-writes (LWW) and read reflects it', async () => {
    await env.srv.store('docs').create('w', { n: 1 }, {})
    await env.srv.store('docs').write('w', { n: 2 })
    expect((await env.srv.store('docs').read('w'))?.data).toEqual({ n: 2 })
  })

  it('grant + revoke edit access rules', async () => {
    await env.srv.store('docs').create('g', {}, { alice: { read: true, write: true } })
    await env.srv.store('docs').grant('g', 'bob', { read: true, write: false })
    expect((await env.srv.store('docs').read('g'))?.accessRules).toEqual({
      alice: { read: true, write: true },
      bob: { read: true, write: false },
    })
    await env.srv.store('docs').revoke('g', 'alice')
    expect((await env.srv.store('docs').read('g'))?.accessRules).toEqual({ bob: { read: true, write: false } })
  })

  it('grant on a missing id throws NOT_FOUND', async () => {
    await expect(env.srv.store('docs').grant('nope', 'x', { read: true, write: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('delete + list', async () => {
    await env.srv.store('docs').create('l1', {}, {})
    await env.srv.store('docs').create('l2', {}, {})
    await env.srv.store('docs').delete('l1')
    expect((await env.srv.store('docs').list()).map((r) => r.id)).toContain('l2')
    expect((await env.srv.store('docs').list()).map((r) => r.id)).not.toContain('l1')
  })

  it('an unconfigured store name throws NOT_FOUND', () => {
    expect(() => env.srv.store('nope')).toThrow(/not configured/)
  })
})

describe('store — wire (ACL + catch-up + fan-out)', () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })
  afterEach(() => env.srv.close())

  it('open returns the catch-up snapshot for a permitted principal', async () => {
    await env.srv.store('docs').create('d1', { v: 1 }, { alice: { read: true, write: true } })
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    expect(await alice.req({ t: 'sopen', n: 'docs', id: 'd1' })).toMatchObject({ t: 'res', d: { v: 1 } })
    alice.close()
  })

  it('open of a non-existent resource is NOT_FOUND', async () => {
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    expect(await alice.req({ t: 'sopen', n: 'docs', id: 'ghost' })).toMatchObject({ t: 'err', code: 'NOT_FOUND' })
    alice.close()
  })

  it('open without read access is FORBIDDEN', async () => {
    await env.srv.store('docs').create('d2', { v: 1 }, { alice: { read: true, write: true } })
    const carol = rawClient(env.transport, 'carol')
    await carol.opened
    expect(await carol.req({ t: 'sopen', n: 'docs', id: 'd2' })).toMatchObject({ t: 'err', code: 'FORBIDDEN' })
    carol.close()
  })

  it('write without write access is FORBIDDEN', async () => {
    await env.srv.store('docs').create('d3', { v: 1 }, { bob: { read: true, write: false } })
    const bob = rawClient(env.transport, 'bob')
    await bob.opened
    await bob.req({ t: 'sopen', n: 'docs', id: 'd3' })
    expect(await bob.req({ t: 'swr', n: 'docs', id: 'd3', u: { v: 2 }, o: 'wbob' })).toMatchObject({
      t: 'err',
      code: 'FORBIDDEN',
    })
    bob.close()
  })

  it('an unknown store name is NOT_FOUND', async () => {
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    expect(await alice.req({ t: 'sopen', n: 'ghoststore', id: 'x' })).toMatchObject({ t: 'err', code: 'NOT_FOUND' })
    alice.close()
  })

  it("a writer's change fans out to other subscribers", async () => {
    await env.srv
      .store('docs')
      .create('d4', { v: 0 }, { alice: { read: true, write: true }, bob: { read: true, write: true } })
    const alice = rawClient(env.transport, 'alice')
    const bob = rawClient(env.transport, 'bob')
    await Promise.all([alice.opened, bob.opened])
    await alice.req({ t: 'sopen', n: 'docs', id: 'd4' })
    await bob.req({ t: 'sopen', n: 'docs', id: 'd4' })

    await alice.req({ t: 'swr', n: 'docs', id: 'd4', u: { v: 1 }, o: 'wAlice' })
    await flush()

    expect(bob.changes().find((f) => f.id === 'd4')).toMatchObject({
      t: 'sch',
      n: 'docs',
      id: 'd4',
      u: { v: 1 },
      o: 'wAlice',
    })
    alice.close()
    bob.close()
  })

  it('a server co-write fans out with a server origin', async () => {
    await env.srv.store('docs').create('d5', { v: 0 }, { alice: { read: true, write: true } })
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    await alice.req({ t: 'sopen', n: 'docs', id: 'd5' })

    await env.srv.store('docs').write('d5', { v: 42 })
    await flush()

    expect(alice.changes().find((f) => f.id === 'd5')).toMatchObject({ t: 'sch', id: 'd5', u: { v: 42 }, o: 'server' })
    alice.close()
  })

  it('a server write(id, data, {origin}) co-write fans out stamped with that custom origin', async () => {
    await env.srv.store('docs').create('d6', { v: 0 }, { alice: { read: true, write: true } })
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    await alice.req({ t: 'sopen', n: 'docs', id: 'd6' })

    await env.srv.store('docs').write('d6', { v: 42 }, { origin: 'harness' })
    await flush()

    expect(alice.changes().find((f) => f.id === 'd6')).toMatchObject({ t: 'sch', id: 'd6', u: { v: 42 }, o: 'harness' })
    alice.close()
  })

  it('a server open(id, {origin}) co-write fans out stamped with that custom origin', async () => {
    await env.srv.store('docs').create('o1', { v: 0 }, { alice: { read: true, write: true } })
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    await alice.req({ t: 'sopen', n: 'docs', id: 'o1' })

    const h = env.srv.store('docs').open('o1', { origin: 'agent:42' })
    h.set({ v: 7 })
    await flush()

    expect(alice.changes().find((f) => f.id === 'o1')).toMatchObject({ t: 'sch', id: 'o1', u: { v: 7 }, o: 'agent:42' })
    h.close()
    alice.close()
  })

  it('a server open(id).delete(path) fans out the key removal', async () => {
    await env.srv.store('docs').create('o2', { keep: 1, drop: 2 }, { alice: { read: true, write: true } })
    const alice = rawClient(env.transport, 'alice')
    await alice.opened
    await alice.req({ t: 'sopen', n: 'docs', id: 'o2' })

    const h = env.srv.store('docs').open('o2')
    h.delete(['drop'])
    await flush()

    expect(alice.changes().find((f) => f.id === 'o2')).toMatchObject({ t: 'sch', id: 'o2', u: { keep: 1 } })
    h.close()
    alice.close()
  })

  it('open on a store without reactive open() throws', () => {
    const bare = {
      clustering: 'relay' as const,
      read: () => ({ id: 'x', accessRules: {}, data: {} }),
      create: () => {},
      apply: () => {},
      setAccess: () => {},
      delete: () => {},
      list: () => [],
      searchPrincipals: () => [],
      onChange: () => () => {},
    }
    const srv2 = createSuperLineServer(contract, {
      transports: [createLoopbackTransport().server],
      authenticate: (h) => ({ role: 'user' as const, ctx: { uid: h.query.uid } }),
      stores: { bare },
    })
    expect(() => srv2.store('bare').open('x')).toThrow(/does not support reactive open/)
    void srv2.close()
  })

  it('grant lets a previously-denied principal open', async () => {
    await env.srv.store('docs').create('d6', { v: 1 }, { alice: { read: true, write: true } })
    const dave = rawClient(env.transport, 'dave')
    await dave.opened
    expect(await dave.req({ t: 'sopen', n: 'docs', id: 'd6' })).toMatchObject({ t: 'err', code: 'FORBIDDEN' })
    await env.srv.store('docs').grant('d6', 'dave', { read: true, write: false })
    expect(await dave.req({ t: 'sopen', n: 'docs', id: 'd6' })).toMatchObject({ t: 'res', d: { v: 1 } })
    dave.close()
  })
})
