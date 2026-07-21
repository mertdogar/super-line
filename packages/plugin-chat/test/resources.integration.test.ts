import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import type { ResourceKindDef } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { chatAgentTools } from '@super-line/plugin-chat/ai-sdk'
import type { ToolSet } from 'ai'
import { createHarness, waitFor } from '../../server/test/harness.js'

const runTool = (tools: ToolSet, name: string, input: unknown): Promise<unknown> =>
  (tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 't', messages: [] })

// Host-declared CRDT collections (presence-tolerant per ADR-0008) + the two chat fragments.
const noteSchema = z.object({
  title: z.string().catch('untitled'),
  body: z.string().catch(''),
  // deliberately catch-less: the one field a writeResource VALIDATION test can trip
  count: z.number().optional(),
})
const sceneSchema = z.object({ name: z.string().catch(''), elements: z.record(z.string(), z.unknown()).catch({}) })

const app = defineContract({
  collections: {
    notes: { schema: noteSchema, crdt: { mode: 'document' } },
    scenes: { schema: sceneSchema, crdt: { mode: 'document' } },
  },
  roles: { user: { clientToServer: {} } },
  plugins: [authContract(), chatContract()],
})

let sceneInits = 0
const kinds: Record<string, ResourceKindDef> = {
  note: { collection: 'notes', init: () => ({ title: 'untitled', body: '' }) }, // owned (default)
  scene: {
    collection: 'scenes',
    lifecycle: 'linked',
    init: (c) => {
      sceneInits++
      return { name: typeof c.params.name === 'string' ? c.params.name : 'scene', elements: {} }
    },
  },
}

const h = createHarness()
afterEach(() => h.dispose())

async function boot(opts?: { hostScenePolicy?: boolean }) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app, resources: { kinds } })
  const { srv, url } = await h.server(app, {
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    crdtCollections: crdtMemoryCollections(),
    // G4 probe: a host policy on a registered kind's collection must throw at construction
    ...(opts?.hostScenePolicy ? { policies: { scenes: { read: () => true, write: () => true } } } : {}),
    plugins: [authKit.plugin, chatKit.plugin],
  } as never)
  return { srv, url, authKit, chatKit }
}

async function newUser(url: string, email: string, name: string) {
  const g = h.client(app, { url, role: 'guest' })
  const { token, userId } = await g.signUp({ email, password: 'passpass', displayName: name })
  g.close()
  const c = h.client(app, {
    url,
    role: 'user',
    params: { token },
    crdtCollections: crdtCollectionsClient(),
  } as never)
  return { c, userId }
}

describe('plugin-chat — channel resources: registry + access', () => {
  it('a member creates an owned resource: registry row, doc created via init, member can open and write', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })

    const row = await ann.c.createResource({ channelId: channel.id, kind: 'note', title: 'Spec' })
    expect(row).toMatchObject({
      channelId: channel.id,
      kind: 'note',
      collection: 'notes',
      title: 'Spec',
      createdBy: ann.userId,
    })
    expect(row.id).toBe(`${channel.id}:note:${row.docId}`)

    const reg = ann.c.collection('resources').subscribe({ filter: eq('channelId', channel.id) })
    await reg.ready
    expect(reg.rows()).toMatchObject([{ kind: 'note', docId: row.docId }])

    const doc = ann.c.collection('notes').open(row.docId)
    await doc.ready
    expect(doc.getSnapshot()).toMatchObject({ title: 'untitled' })
    doc.update({ title: 'from ann' })

    // convergence via a second member's handle (client writes ack asynchronously)
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    await bob.c.joinChannel({ channelId: channel.id })
    const doc2 = bob.c.collection('notes').open(row.docId)
    await doc2.ready
    await waitFor(() => (doc2.getSnapshot() as { title?: string })?.title === 'from ann')
  })

  it('owned kinds refuse client-supplied ids; unknown kinds are NOT_FOUND', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    await expect(ann.c.createResource({ channelId: channel.id, kind: 'note', id: 'mine' })).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    await expect(ann.c.createResource({ channelId: channel.id, kind: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('non-members see no registry rows and cannot open the doc; joining unlocks both', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const eve = await newUser(url, 'eve@x.com', 'Eve')
    const channel = await ann.c.createChannel({ name: 'general' })
    const row = await ann.c.createResource({ channelId: channel.id, kind: 'note' })

    const reg = eve.c.collection('resources').subscribe({ filter: eq('channelId', channel.id) })
    await reg.ready
    expect(reg.rows()).toEqual([])
    const locked = eve.c.collection('notes').open(row.docId)
    await expect(locked.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })
    locked.close()

    await eve.c.joinChannel({ channelId: channel.id })
    const open = eve.c.collection('notes').open(row.docId)
    await open.ready
    expect(open.getSnapshot()).toMatchObject({ title: 'untitled' })
  })

  it('an unattached doc is invisible through chat even to members', async () => {
    const { url, srv } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    await ann.c.createChannel({ name: 'general' })
    await srv.collection('notes').create('loose', { title: 'no registry row', body: '' })
    const doc = ann.c.collection('notes').open('loose')
    await expect(doc.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('plugin-chat — channel resources: linked lifecycle', () => {
  it('create-or-attach: a host id creates once, attaches everywhere else, and races settle as attach', async () => {
    const { url } = await boot()
    sceneInits = 0
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const chA = await ann.c.createChannel({ name: 'a' })
    const chB = await ann.c.createChannel({ name: 'b' })

    const first = await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'S1', params: { name: 'hero' } })
    expect(first).toMatchObject({ docId: 'S1', collection: 'scenes' })
    expect(sceneInits).toBe(1)

    // attach the SAME doc to a second channel — init must not re-run (pre-check; name stays 'hero')
    await ann.c.createResource({ channelId: chB.id, kind: 'scene', id: 'S1', params: { name: 'clobber' } })
    expect(sceneInits).toBe(1) // the attach path never paid a side-effecting init
    const doc = ann.c.collection('scenes').open('S1')
    await doc.ready
    expect((doc.getSnapshot() as { name?: string }).name).toBe('hero')

    // same-channel race: both callers succeed onto ONE row
    const [r1, r2] = await Promise.all([
      ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'S1' }),
      ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'S1' }),
    ])
    expect(r1.id).toBe(r2.id)
    const reg = ann.c.collection('resources').subscribe({ filter: eq('docId', 'S1') })
    await reg.ready
    expect(reg.rows()).toHaveLength(2) // one per channel, never duplicated
  })

  it('multi-channel access: membership in ANY attaching channel grants the doc; detach elsewhere does not revoke it', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const chA = await ann.c.createChannel({ name: 'a', visibility: 'private' })
    const chB = await ann.c.createChannel({ name: 'b' })
    await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'S1' })
    await ann.c.createResource({ channelId: chB.id, kind: 'scene', id: 'S1' })

    await bob.c.joinChannel({ channelId: chB.id }) // member of B only
    const viaB = bob.c.collection('scenes').open('S1')
    await viaB.ready
    viaB.close()

    await ann.c.detachResource({ channelId: chA.id, kind: 'scene', docId: 'S1' }) // linked: doc untouched, A's row gone
    const still = bob.c.collection('scenes').open('S1')
    await still.ready
    expect(still.getSnapshot()).toBeDefined()
  })

  it('owned detach deletes the doc; linked detach never does', async () => {
    const { url, srv } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    const note = await ann.c.createResource({ channelId: channel.id, kind: 'note' })
    const scene = await ann.c.createResource({ channelId: channel.id, kind: 'scene', id: 'S1' })

    await ann.c.detachResource({ channelId: channel.id, kind: 'note', docId: note.docId })
    expect(await srv.collection('notes').read(note.docId)).toBeUndefined()

    await ann.c.detachResource({ channelId: channel.id, kind: 'scene', docId: scene.docId })
    expect(await srv.collection('scenes').read('S1')).toBeDefined()
  })

  it('deleteChannel cascades: registry rows gone, owned docs deleted, linked docs survive', async () => {
    const { url, srv, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    const note = await ann.c.createResource({ channelId: channel.id, kind: 'note' })
    await ann.c.createResource({ channelId: channel.id, kind: 'scene', id: 'S1' })

    await ann.c.deleteChannel({ id: channel.id })
    expect(await chatKit.resources.of(channel.id)).toEqual([])
    expect(await srv.collection('notes').read(note.docId)).toBeUndefined()
    expect(await srv.collection('scenes').read('S1')).toBeDefined()
  })
})

describe('plugin-chat — channel resources: cards, kit, boot validation', () => {
  it('client create/detach drop resource cards: content-absent messages carrying metadata.resource', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    const row = await ann.c.createResource({ channelId: channel.id, kind: 'note', title: 'Spec' })
    await ann.c.detachResource({ channelId: channel.id, kind: 'note', docId: row.docId })

    const msgs = ann.c.collection('messages').subscribe({ filter: eq('channelId', channel.id) })
    await msgs.ready
    const cards = msgs.rows().map((m) => (m.metadata as { resource?: unknown } | undefined)?.resource)
    expect(cards).toMatchObject([
      { action: 'created', kind: 'note', title: 'Spec' },
      { action: 'detached', kind: 'note', title: 'Spec' },
    ])
    for (const m of msgs.rows()) expect(m.content).toBeUndefined()
    expect(msgs.rows().every((m) => m.authorId === ann.userId)).toBe(true)
  })

  it('kit create is membership-free, cardless, createdBy null; kit detach works', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })

    const row = await chatKit.resources.create({ channelId: channel.id, kind: 'note' })
    expect(row.createdBy).toBeNull()
    expect(await chatKit.resources.of(channel.id)).toHaveLength(1)

    const msgs = ann.c.collection('messages').subscribe({ filter: eq('channelId', channel.id) })
    await msgs.ready
    expect(msgs.rows()).toEqual([]) // no card for server-initiated ops

    await chatKit.resources.detach(channel.id, 'note', row.docId)
    expect(await chatKit.resources.of(channel.id)).toEqual([])
  })

  it('writeResource: acked path ops — deep sets merge per-property, deletes remove keys, snapshot returns', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    await ann.c.createResource({ channelId: channel.id, kind: 'scene', id: 'S1' })

    await ann.c.writeResource({ channelId: channel.id, kind: 'scene', docId: 'S1', ops: [{ path: ['elements', 'a'], set: { x: 1 } }] })
    const { snapshot } = await ann.c.writeResource({
      channelId: channel.id,
      kind: 'scene',
      docId: 'S1',
      ops: [{ path: ['elements', 'b'], set: { x: 2 } }],
    })
    // per-property merge: writing element b must not clobber sibling a
    expect(snapshot).toMatchObject({ elements: { a: { x: 1 }, b: { x: 2 } } })

    const after = await ann.c.writeResource({
      channelId: channel.id,
      kind: 'scene',
      docId: 'S1',
      ops: [{ path: ['elements', 'a'], delete: true }],
    })
    expect((after.snapshot as { elements: Record<string, unknown> }).elements).toEqual({ b: { x: 2 } })
  })

  it('writeResource: schema-invalid results reject VALIDATION and change nothing; the gate needs the exact channel triple', async () => {
    const { url, srv } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const eve = await newUser(url, 'eve@x.com', 'Eve')
    const chA = await ann.c.createChannel({ name: 'a' })
    const chB = await ann.c.createChannel({ name: 'b' })
    const note = await ann.c.createResource({ channelId: chA.id, kind: 'note' })

    await expect(
      ann.c.writeResource({ channelId: chA.id, kind: 'note', docId: note.docId, ops: [{ path: ['count'], set: 'NaN' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining("rejected by the 'note' schema") })
    expect(await srv.collection('notes').read(note.docId)).toMatchObject({ title: 'untitled' })
    expect(((await srv.collection('notes').read(note.docId)) as { count?: unknown }).count).toBeUndefined()

    // the doc is attached to A, not B — naming B must NOT_FOUND even for a member of both
    await expect(
      ann.c.writeResource({ channelId: chB.id, kind: 'note', docId: note.docId, ops: [{ path: ['count'], set: 1 }] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // a non-member is FORBIDDEN outright
    await expect(
      eve.c.writeResource({ channelId: chA.id, kind: 'note', docId: note.docId, ops: [{ path: ['count'], set: 1 }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('writeResource guards its op shape: array-indexing paths and set-less/delete-less ops are rejected', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    await ann.c.createResource({ channelId: channel.id, kind: 'scene', id: 'S1' })
    // plant an array VALUE (legal — whole-array set at an object key)…
    await ann.c.writeResource({
      channelId: channel.id,
      kind: 'scene',
      docId: 'S1',
      ops: [{ path: ['elements', 'list'], set: [1, 2, 3] }],
    })
    // …then stepping INTO it must be rejected before anything touches the live doc
    await expect(
      ann.c.writeResource({
        channelId: channel.id,
        kind: 'scene',
        docId: 'S1',
        ops: [{ path: ['elements', 'list', '0'], set: 9 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('indexes into an array') })
    // a bare { path } op (neither set nor delete) is an honest error, not a silent undefined-write
    await expect(
      ann.c.writeResource({
        channelId: channel.id,
        kind: 'scene',
        docId: 'S1',
        ops: [{ path: ['name'] } as never],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('boot validation: kinds must point at declared CRDT collections; a host policy on a kind collection collides', async () => {
    expect(() =>
      chat({ contract: app, resources: { kinds: { bad: { collection: 'channels', init: () => ({}) } } } }),
    ).toThrow(/not a CRDT collection/)
    expect(() =>
      chat({ contract: app, resources: { kinds: { bad: { collection: 'ghosts', init: () => ({}) } } } }),
    ).toThrow(/unknown collection/)
    await expect(boot({ hostScenePolicy: true })).rejects.toThrow(/collides with an existing policy/)
  })

  it('resource cards are ordinary envelopes; hosts decide whether they trigger automation', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bot = await newUser(url, 'bot@x.com', 'Bot')
    const channel = await ann.c.createChannel({ name: 'general' })
    await ann.c.addMember({ channelId: channel.id, userId: bot.userId })

    const botChat = chatClient(bot.c, { userId: bot.userId })
    await botChat.ready
    const messages = botChat.messages(channel.id)
    await messages.ready

    await ann.c.createResource({ channelId: channel.id, kind: 'note' })
    await ann.c.sendMessage({ channelId: channel.id, content: 'hello bot' })
    await waitFor(() => messages.rows().length === 2)
    expect(messages.rows().find((message) => message.content === 'hello bot')).toBeDefined()
    const card = messages
      .rows()
      .find((message) => (message.metadata?.resource as { action?: string } | undefined)?.action === 'created')
    expect(card).toBeDefined()
    expect(card).not.toHaveProperty('content')

    const history = await botChat.history(channel.id)
    expect(history.messages).toHaveLength(2)
    messages.close()
    botChat.close()
  })

  it('presence: announce/heartbeat/close upsert per-user rows, membership-scoped reads, sweepPresence reaps', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const eve = await newUser(url, 'eve@x.com', 'Eve')
    const channel = await ann.c.createChannel({ name: 'general', visibility: 'private' })
    await ann.c.addMember({ channelId: channel.id, userId: bob.userId })
    const row = await ann.c.createResource({ channelId: channel.id, kind: 'scene', id: 'S1' })

    await ann.c.announceResource({ kind: 'scene', docId: 'S1', state: 'open' })
    await bob.c.announceResource({ kind: 'scene', docId: 'S1', state: 'open' })
    await expect(eve.c.announceResource({ kind: 'scene', docId: 'S1', state: 'open' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    const seen = bob.c.collection('resourcePresence').subscribe({ filter: eq('docKey', `${row.collection}:S1`) })
    await seen.ready
    expect(seen.rows().map((p) => p.userId).sort()).toEqual([ann.userId, bob.userId].sort())

    // a second open (another tab) is the same per-user row, heartbeat just bumps it
    const before = seen.rows().find((p) => p.userId === ann.userId)!
    await ann.c.announceResource({ kind: 'scene', docId: 'S1', state: 'heartbeat' })
    await waitFor(() => {
      const now = seen.rows().find((p) => p.userId === ann.userId)
      return now !== undefined && now.heartbeatAt >= before.heartbeatAt && seen.rows().length === 2
    })

    // eve can't SEE presence either (no membership → docKey filter excludes it)
    const hidden = eve.c.collection('resourcePresence').subscribe({ filter: eq('docKey', `${row.collection}:S1`) })
    await hidden.ready
    expect(hidden.rows()).toEqual([])

    await ann.c.announceResource({ kind: 'scene', docId: 'S1', state: 'close' })
    await waitFor(() => seen.rows().length === 1)

    // sweep: bob's row is fresh (kept); backdate nothing — sweep with 0ms reaps everything stale-or-not older than now
    expect(await chatKit.resources.sweepPresence({ olderThanMs: 60_000 })).toBe(0)
    expect(await chatKit.resources.sweepPresence({ olderThanMs: -1_000 })).toBe(1)
  })

  it('the /ai resource tools work end-to-end over the bot connection, VALIDATION errors included', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bot = await newUser(url, 'bot@x.com', 'Bot')
    const channel = await ann.c.createChannel({ name: 'general' })
    await ann.c.addMember({ channelId: channel.id, userId: bot.userId })
    const tools = chatAgentTools(bot.c, { resourceShapes: { note: '{ title: string, body: string, count?: number }' } })

    const created = (await runTool(tools, 'create_resource', {
      channelId: channel.id,
      kind: 'note',
      title: 'Plan',
    })) as { kind: string; docId: string }
    expect(created).toMatchObject({ kind: 'note', title: 'Plan' })

    const listed = (await runTool(tools, 'list_resources', { channelId: channel.id })) as unknown[]
    expect(listed).toMatchObject([{ kind: 'note', docId: created.docId }])

    const written = (await runTool(tools, 'write_resource', {
      channelId: channel.id,
      kind: 'note',
      docId: created.docId,
      ops: [{ path: ['body'], set: 'agent wrote this' }],
    })) as { ok?: boolean; snapshot?: unknown }
    expect(written.ok).toBe(true)
    expect(written.snapshot).toMatchObject({ body: 'agent wrote this' })

    const bad = (await runTool(tools, 'write_resource', {
      channelId: channel.id,
      kind: 'note',
      docId: created.docId,
      ops: [{ path: ['count'], set: 'not a number' }],
    })) as { error?: string; message?: string }
    expect(bad.error).toBe('VALIDATION')

    const read = (await runTool(tools, 'read_resource', {
      channelId: channel.id,
      kind: 'note',
      docId: created.docId,
    })) as { snapshot?: unknown }
    expect(read.snapshot).toMatchObject({ body: 'agent wrote this' })

    const detached = (await runTool(tools, 'detach_resource', {
      channelId: channel.id,
      kind: 'note',
      docId: created.docId,
    })) as { ok?: boolean }
    expect(detached.ok).toBe(true)
    expect((await runTool(tools, 'list_resources', { channelId: channel.id })) as unknown[]).toEqual([])
  })
})

describe('plugin-chat — channel resources: the access-resolver surface', () => {
  /** The kind guard's real verdict, driven through a client `open()` — not by calling the policy. */
  const canOpen = async (c: Awaited<ReturnType<typeof newUser>>['c'], collection: 'notes' | 'scenes', id: string) => {
    const doc = c.collection(collection).open(id)
    try {
      await doc.ready
      return true
    } catch {
      return false
    } finally {
      doc.close()
    }
  }

  it('channelsOfDoc lists every granting channel; an unattached doc grants none', async () => {
    const { url, srv, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const chA = await ann.c.createChannel({ name: 'a' })
    const chB = await ann.c.createChannel({ name: 'b' })
    await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'S1' })
    await ann.c.createResource({ channelId: chB.id, kind: 'scene', id: 'S1' })

    expect((await chatKit.resources.channelsOfDoc('scenes', 'S1')).sort()).toEqual([chA.id, chB.id].sort())

    await srv.collection('scenes').create('loose', { name: 'no registry row', elements: {} })
    expect(await chatKit.resources.channelsOfDoc('scenes', 'loose')).toEqual([])
  })

  it('canAccessDoc: membership in ANY granting channel is enough; non-members are denied', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const eve = await newUser(url, 'eve@x.com', 'Eve')
    const chA = await ann.c.createChannel({ name: 'a', visibility: 'private' })
    const chB = await ann.c.createChannel({ name: 'b' })
    await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'S1' })
    await ann.c.createResource({ channelId: chB.id, kind: 'scene', id: 'S1' })
    await bob.c.joinChannel({ channelId: chB.id }) // member of B only

    expect(await chatKit.resources.canAccessDoc('scenes', 'S1', ann.userId)).toBe(true)
    expect(await chatKit.resources.canAccessDoc('scenes', 'S1', bob.userId)).toBe(true)
    expect(await chatKit.resources.canAccessDoc('scenes', 'S1', eve.userId)).toBe(false)
  })

  // THE invariant server.ts asserts in prose but nothing enforced: the kit resolver, the bulk id
  // read, and the auto-contributed CRDT kind guard must never disagree about one (doc, principal).
  it('docIdsOf, canAccessDoc and the kind guard agree across the access matrix', async () => {
    const { url, srv, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const eve = await newUser(url, 'eve@x.com', 'Eve')
    const chA = await ann.c.createChannel({ name: 'a', visibility: 'private' })
    const chB = await ann.c.createChannel({ name: 'b', visibility: 'private' })
    await chatKit.members.add(chB.id, bob.userId) // private: added by the kit, not self-joined

    await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'shared' }) // A + B
    await ann.c.createResource({ channelId: chB.id, kind: 'scene', id: 'shared' })
    await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'aOnly' }) // A only
    await ann.c.createResource({ channelId: chA.id, kind: 'scene', id: 'detached' })
    await ann.c.detachResource({ channelId: chA.id, kind: 'scene', docId: 'detached' }) // linked: doc survives, row gone
    await srv.collection('scenes').create('loose', { name: 'never attached', elements: {} })

    const users = [ann, bob, eve]
    for (const u of users) {
      const ids = await chatKit.resources.docIdsOf('scenes', u.userId)
      for (const docId of ['shared', 'aOnly', 'detached', 'loose']) {
        const viaIds = ids.includes(docId)
        const viaResolver = await chatKit.resources.canAccessDoc('scenes', docId, u.userId)
        const viaGuard = await canOpen(u.c, 'scenes', docId)
        expect({ docId, viaIds, viaResolver, viaGuard }).toEqual({
          docId,
          viaIds: viaGuard,
          viaResolver: viaGuard,
          viaGuard,
        })
      }
    }

    // and the matrix is non-trivial — otherwise the agreement above is vacuous
    expect((await chatKit.resources.docIdsOf('scenes', ann.userId)).sort()).toEqual(['aOnly', 'shared'])
    expect(await chatKit.resources.docIdsOf('scenes', bob.userId)).toEqual(['shared'])
    expect(await chatKit.resources.docIdsOf('scenes', eve.userId)).toEqual([])
  })

  it('docIdsOf is scoped by collection: the same docId in another collection never bleeds through', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const channel = await ann.c.createChannel({ name: 'general' })
    await ann.c.createResource({ channelId: channel.id, kind: 'scene', id: 'X' })

    expect(await chatKit.resources.docIdsOf('scenes', ann.userId)).toEqual(['X'])
    expect(await chatKit.resources.docIdsOf('notes', ann.userId)).toEqual([])
    expect(await chatKit.resources.canAccessDoc('notes', 'X', ann.userId)).toBe(false)
    expect(await chatKit.resources.channelsOfDoc('notes', 'X')).toEqual([])
  })

  it('the doc resolvers throw on a collection no registered kind points at', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    await expect(chatKit.resources.channelsOfDoc('typo', 'X')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(chatKit.resources.canAccessDoc('typo', 'X', ann.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(chatKit.resources.docIdsOf('typo', ann.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('resources.find reads across channels; members.get point-reads a membership with its role', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const chA = await ann.c.createChannel({ name: 'a' })
    const chB = await ann.c.createChannel({ name: 'b' })
    await ann.c.createResource({ channelId: chA.id, kind: 'note' })
    await ann.c.createResource({ channelId: chB.id, kind: 'scene', id: 'S1' })
    await bob.c.joinChannel({ channelId: chB.id })

    expect(await chatKit.resources.find()).toHaveLength(2)
    expect(await chatKit.resources.find({ filter: eq('collection', 'scenes') })).toMatchObject([{ docId: 'S1' }])
    expect(await chatKit.resources.find({ limit: 1 })).toHaveLength(1)

    expect(await chatKit.members.get(chA.id, ann.userId)).toMatchObject({ userId: ann.userId, role: 'owner' })
    expect(await chatKit.members.get(chB.id, bob.userId)).toMatchObject({ userId: bob.userId, role: 'member' })
    expect(await chatKit.members.get(chA.id, bob.userId)).toBeUndefined()
  })
})
