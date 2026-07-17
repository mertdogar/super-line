import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { createHarness, waitFor } from './harness.js'
import type { CollectionPolicy } from '@super-line/server'
import type { CollectionStore, RowChange } from '@super-line/core'

const chat = defineContract({
  collections: {
    users: { schema: z.object({ id: z.string(), name: z.string() }), key: 'id' },
    messages: {
      schema: z.object({ id: z.string(), channelId: z.string(), authorId: z.string(), text: z.string(), createdAt: z.number() }),
      key: 'id',
      references: { authorId: 'users' },
    },
  },
  roles: { user: { clientToServer: { noop: { input: z.void(), output: z.void() } } } },
})

type Ctx = { userId: string }
type MsgRow = { id: string; channelId: string; authorId: string; text: string; createdAt: number }

const authenticate = (h: { query: Record<string, string> }) => ({ role: 'user' as const, ctx: { userId: h.query.userId ?? 'anon' } })
const identify = (conn: { ctx: unknown }) => (conn.ctx as Ctx).userId

// author-only writes: you may only create/edit/delete rows whose authorId is you.
const authorOnly: CollectionPolicy<Ctx, MsgRow>['write'] = (principal, op, next, prev) =>
  op === 'delete' ? prev?.authorId === principal : next?.authorId === principal

const msg = (id: string, channelId: string, authorId: string, n: number): MsgRow => ({ id, channelId, authorId, text: `m${n}`, createdAt: n })

const h = createHarness()
afterEach(() => h.dispose())

describe('collections — snapshot, filtering, live routing', () => {
  it('a write racing the subscribe snapshot is NOT lost (server registers-then-reads; client replays)', async () => {
    // A store whose snapshot result goes STALE before it returns: rows are read immediately, then
    // the response stalls — any write during the stall is missing from the snapshot, so it must
    // reach the subscriber as a live cchg. Before the fix the sub was registered only after the
    // read returned: the racing write landed in NEITHER the snapshot NOR the feed (the
    // auto-join-on-connect race — a permanently deaf UI).
    const real = memoryCollections()
    let armed = false
    let onRead!: () => void
    const readDone = new Promise<void>((r) => (onRead = r))
    let release!: () => void
    const released = new Promise<void>((r) => (release = r))
    const slow = new Proxy(real, {
      get(t, p, r) {
        if (p === 'snapshot')
          return async (...args: unknown[]) => {
            const rows = await (t as unknown as { snapshot: (...a: unknown[]) => Promise<unknown[]> }).snapshot(...args)
            if (armed) {
              armed = false
              onRead() // rows are now frozen — the race window is open
              await released
            }
            return rows
          }
        return Reflect.get(t, p, r)
      },
    }) as typeof real
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: slow,
      policies: {
        users: { read: () => undefined, write: () => true },
        messages: { read: () => undefined, write: authorOnly },
      },
    })
    await srv.collection('messages').insert(msg('m1', 'general', 'u9', 1))

    armed = true
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await readDone // the snapshot HAS been read (m1 only) and is stalled
    await srv.collection('messages').insert(msg('m2', 'general', 'u9', 2)) // the racing co-write
    release()
    await sub.ready
    expect(sub.rows().map((r) => r.id).sort()).toEqual(['m1', 'm2'])
  })

  it('seeds a filtered snapshot then streams matching inserts, ignoring non-matching ones', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: {
        users: { read: () => undefined, write: () => true },
        messages: { read: () => undefined, write: authorOnly },
      },
    })
    await srv.collection('messages').insert(msg('m1', 'general', 'u9', 1))
    await srv.collection('messages').insert(msg('m2', 'random', 'u9', 2))

    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general'), orderBy: [{ field: 'createdAt', dir: 'asc' }] })
    await sub.ready
    expect(sub.rows().map((r) => r.id)).toEqual(['m1']) // only the general one

    await client.collection('messages').insert(msg('m3', 'general', 'u1', 3)) // matches → arrives
    await client.collection('messages').insert(msg('m4', 'random', 'u1', 4)) // doesn't match → ignored
    await waitFor(() => sub.rows().length === 2)
    expect(sub.rows().map((r) => r.id)).toEqual(['m1', 'm3'])
  })

  it('never leaks the inspector-only timestamps to a subscribed client (rows stay exactly the schema)', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { read: () => undefined, write: authorOnly }, users: { read: () => undefined, write: () => true } },
    })
    await srv.collection('messages').insert(msg('m1', 'general', 'u1', 1)) // seed (snapshot path)

    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await sub.ready
    await client.collection('messages').insert(msg('m2', 'general', 'u1', 2)) // live (cchg path)
    await waitFor(() => sub.rows().length === 2)

    // The client's row keys are exactly the declared schema — `_createdAt`/`_updatedAt` are inspector-only and
    // must never ride cbat/cchg. (`createdAt` here is the user's own schema field, not the reserved one.)
    for (const r of sub.rows()) {
      expect(Object.keys(r as object).sort()).toEqual(['authorId', 'channelId', 'createdAt', 'id', 'text'])
      expect(r).not.toHaveProperty('_createdAt')
      expect(r).not.toHaveProperty('_updatedAt')
    }
  })

  it('delivers a row-set change event to a plain subscriber', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await sub.ready
    const events: string[] = []
    sub.subscribe((ev) => events.push(`${ev.type}:${ev.id}`))

    await srv.collection('messages').insert(msg('m1', 'general', 'srv', 1))
    await waitFor(() => events.length === 1)
    expect(events).toEqual(['insert:m1'])
  })
})

describe('collections — row policies', () => {
  it('rejects a write that fails the write guard (author-only)', async () => {
    const { url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    await expect(client.collection('messages').insert(msg('x', 'general', 'someoneElse', 1))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('denies reads by default (a collection with no read policy)', async () => {
    const { url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { write: authorOnly } }, // no `read` ⇒ denied
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({})
    await expect(sub.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('applies the read policy filter as a hard visibility boundary', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      // a caller may only ever see the 'general' channel, regardless of the filter they ask for
      policies: { messages: { read: () => eq('channelId', 'general'), write: authorOnly } },
    })
    await srv.collection('messages').insert(msg('m1', 'general', 'srv', 1))
    await srv.collection('messages').insert(msg('m2', 'secret', 'srv', 2))

    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({}) // asks for everything
    await sub.ready
    expect(sub.rows().map((r) => r.id)).toEqual(['m1']) // policy hid the secret channel
  })
})

describe('collections — atomic batches & filter transitions', () => {
  it('a batch is all-or-nothing: one denied op rolls back the whole batch', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    await expect(
      client.collection('messages').batch([
        { type: 'insert', row: msg('ok', 'general', 'u1', 1) },
        { type: 'insert', row: msg('bad', 'general', 'u2', 2) }, // not my message → whole batch rejected
      ]),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await srv.collection('messages').read('ok')).toBeUndefined() // rolled back
  })

  it('an update that moves a row out of the filter arrives as a delete', async () => {
    const { url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await sub.ready
    await client.collection('messages').insert(msg('m1', 'general', 'u1', 1))
    await waitFor(() => sub.rows().length === 1)

    await client.collection('messages').update({ ...msg('m1', 'random', 'u1', 1) }) // leaves the 'general' filter
    await waitFor(() => sub.rows().length === 0)
  })
})

describe('collections — durable backend drop-in', () => {
  it('serves a filtered subset end-to-end with the sqlite backend', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: sqliteCollections({ file: ':memory:', collections: chat.collections }), // same CollectionStore contract as memory
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    await srv.collection('messages').insert(msg('m1', 'general', 'u9', 1))

    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await sub.ready
    expect(sub.rows().map((r) => r.id)).toEqual(['m1'])

    await client.collection('messages').insert(msg('m2', 'general', 'u1', 2))
    await waitFor(() => sub.rows().length === 2)
  })

  it('routes a self-backend delete (no prior row) to subscribers, who remove it', async () => {
    // A `self` backend (e.g. pglite) surfaces deletes via its Electric feed WITHOUT the prior row. Simulate one
    // with a fake self-store whose onChange we can fire directly.
    let fire: (c: RowChange) => void = () => {}
    const fakeSelf: CollectionStore = {
      clustering: 'self',
      apply: () => {}, // `self`: apply returns nothing and fires no onChange — the feed does (ADR-0009)
      snapshot: (n) => (n === 'messages' ? [msg('m1', 'general', 'u1', 1)] : []),
      read: () => undefined,
      onChange: (cb) => {
        fire = cb
        return () => {}
      },
    }
    const { url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: fakeSelf,
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    const sub = client.collection('messages').subscribe({ filter: eq('channelId', 'general') })
    await sub.ready
    expect(sub.rows().map((r) => r.id)).toEqual(['m1']) // from the snapshot

    fire({ n: 'messages', k: 'delete', id: 'm1', origin: 'x' }) // prev-less delete off the feed
    await waitFor(() => sub.rows().length === 0)
  })
})

describe('collections — advisory foreign keys', () => {
  it('rejects a dangling reference when checkReferences is on, then accepts it once the parent exists', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      checkReferences: true,
      policies: { users: { read: () => undefined, write: () => true }, messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    // messages.authorId references users; no users/u1 row yet → dangling
    await expect(client.collection('messages').insert(msg('m1', 'general', 'u1', 1))).rejects.toMatchObject({ code: 'VALIDATION' })

    await srv.collection('users').insert({ id: 'u1', name: 'Ada' })
    await client.collection('messages').insert(msg('m1', 'general', 'u1', 1)) // parent exists now → ok
    expect(await srv.collection('messages').read('m1')).toMatchObject({ id: 'm1' })
  })

  it('allows dangling references by default (the check is opt-in)', async () => {
    const { srv, url } = await h.server<typeof chat, { role: 'user'; ctx: Ctx }>(chat, {
      authenticate,
      identify,
      collections: memoryCollections(),
      policies: { messages: { read: () => undefined, write: authorOnly } },
    })
    const client = h.client(chat, { url, role: 'user', params: { userId: 'u1' } })
    await client.collection('messages').insert(msg('m1', 'general', 'u1', 1)) // no users/u1 row, but the check is off
    expect(await srv.collection('messages').read('m1')).toMatchObject({ id: 'm1' })
  })
})
