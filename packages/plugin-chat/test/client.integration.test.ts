import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import type { ChatStreamingOptions } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { createHarness, waitFor } from '../../server/test/harness.js'

const app = defineContract({
  roles: {
    user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract(), chatContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

async function boot(opts?: { streaming?: ChatStreamingOptions }) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app, ...(opts?.streaming ? { streaming: opts.streaming } : {}) })
  const { srv, url } = await h.server(app, {
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin, chatKit.plugin],
  })
  srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)
  return { srv, url, authKit, chatKit }
}

async function newUser(url: string, email: string, name: string) {
  const g = h.client(app, { url, role: 'guest' })
  const { token, userId } = await g.signUp({ email, password: 'passpass', displayName: name })
  g.close()
  const c = h.client(app, { url, role: 'user', params: { token } })
  return { c, userId }
}

describe('plugin-chat/client — live stores', () => {
  it('stores deliver the snapshot and stream live changes; request wrappers round-trip', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const chat = chatClient(ann.c, { userId: ann.userId })
    await chat.ready

    const channels = chat.channels()
    await channels.ready
    expect(channels.rows()).toEqual([])

    const ch = await chat.createChannel({ name: 'general' })
    await waitFor(() => channels.rows().some((c) => c.name === 'general'))

    const feed = chat.messages(ch.id)
    const members = chat.members(ch.id)
    await Promise.all([feed.ready, members.ready])
    expect(members.rows()).toMatchObject([{ userId: ann.userId, role: 'owner' }])

    const sent = await chat.send(ch.id, 'hello world')
    expect(sent.content).toBe('hello world')
    await waitFor(() => feed.rows().length === 1)

    const edited = await chat.editMessage(sent.id, { content: 'hello, world' })
    expect(edited.editedAt).toEqual(expect.any(Number))
    await waitFor(() => feed.rows()[0]?.content === 'hello, world')

    await chat.deleteMessage(sent.id)
    await waitFor(() => feed.rows().length === 0)
    chat.close()
    ann.c.close()
  })

  it('THE MECHANIC: an open message store goes from empty to backlog when the user joins — same store object', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    const bobChat = chatClient(bob.c, { userId: bob.userId })
    await Promise.all([annChat.ready, bobChat.ready])

    const ch = await annChat.createChannel({ name: 'general' })
    await annChat.send(ch.id, 'before bob joined')

    const feed = bobChat.messages(ch.id) // opened while NOT a member
    await feed.ready
    expect(feed.rows()).toEqual([]) // RLS: nothing visible

    await bobChat.join(ch.id)
    // the store notices the membership change and re-subscribes — the backlog streams into the SAME store
    await waitFor(() => feed.rows().some((m) => m.content === 'before bob joined'))

    await bobChat.leave(ch.id)
    await waitFor(() => feed.rows().length === 0) // and drains again after leaving
    annChat.close()
    bobChat.close()
    ann.c.close()
    bob.c.close()
  })

  it('a private channel appears in an open channels() store when an owner adds the user', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    const bobChat = chatClient(bob.c) // userId resolved via whoami — the other construction path
    await Promise.all([annChat.ready, bobChat.ready])

    const secret = await annChat.createChannel({ name: 'secret', visibility: 'private' })
    const dir = bobChat.channels()
    await dir.ready
    expect(dir.rows()).toEqual([])

    await annChat.addMember(secret.id, bob.userId)
    await waitFor(() => dir.rows().some((c) => c.name === 'secret'))
    annChat.close()
    bobChat.close()
    ann.c.close()
    bob.c.close()
  })

  it('messages() maintains a newest-N window presented chronologically', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const chat = chatClient(ann.c, { userId: ann.userId })
    await chat.ready
    const ch = await chat.createChannel({ name: 'busy' })

    for (let i = 1; i <= 5; i++) await chat.send(ch.id, `msg ${i}`)
    const feed = chat.messages(ch.id, { limit: 3 })
    await feed.ready
    expect(feed.rows().map((m) => m.content)).toEqual(['msg 3', 'msg 4', 'msg 5']) // newest 3, oldest→newest

    await chat.send(ch.id, 'msg 6')
    await waitFor(() => feed.rows().map((m) => m.content).join() === 'msg 4,msg 5,msg 6') // window slides
    chat.close()
    ann.c.close()
  })
})

describe('plugin-chat/client — streaming (assembled feed + writer)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('a viewer sees live delta-driven text BEFORE any checkpoint or finalize; plain messages pass through untouched', async () => {
    const { url } = await boot({ streaming: { checkpointMs: 60_000 } }) // liveness here can only come from deltas
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    const bobChat = chatClient(bob.c, { userId: bob.userId })
    await Promise.all([annChat.ready, bobChat.ready])

    const ch = await annChat.createChannel({ name: 'general' })
    await bobChat.join(ch.id)
    await annChat.send(ch.id, 'plain first')

    const feed = bobChat.messages(ch.id)
    await feed.ready
    await sleep(20) // margin for the fire-and-forget watchChannel to land before deltas fly

    const w = await annChat.stream(ch.id)
    w.push(
      { type: 'part_start', key: 't', partType: 'text' },
      { type: 'delta', key: 't', text: 'Hello ' },
      { type: 'delta', key: 't', text: 'world' },
    )
    await w.flush()

    // live text assembled from spliced deltas — the part ROW still holds '' (checkpoint is 60s away)
    await waitFor(() => {
      const m = feed.rows().find((r) => r.id === w.messageId)
      return m?.parts?.[0]?.text === 'Hello world'
    })
    const streaming = feed.rows().find((r) => r.id === w.messageId)!
    expect(streaming.status).toBe('streaming')
    expect(streaming.content).toBeUndefined()

    // the plain message is untouched: no parts, no status
    const plain = feed.rows().find((r) => r.content === 'plain first')!
    expect(plain.parts).toBeUndefined()
    expect(plain.status).toBeUndefined()

    const done = await w.finalize()
    expect(done).toMatchObject({ status: 'complete', content: 'Hello world' })
    await waitFor(() => feed.rows().find((r) => r.id === w.messageId)?.status === 'complete')
    annChat.close()
    bobChat.close()
    ann.c.close()
    bob.c.close()
  })

  it('assembles subagent trees in parent order with live text on every lane', async () => {
    const { url } = await boot({ streaming: { checkpointMs: 60_000 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'ops' })
    const feed = annChat.messages(ch.id)
    await feed.ready
    await sleep(20) // margin for the fire-and-forget watchChannel to land before deltas fly

    const w = await annChat.stream(ch.id)
    w.push(
      { type: 'part_start', key: 'root', partType: 'text' },
      { type: 'delta', key: 'root', text: 'delegating… ' },
      { type: 'part_start', key: 'call-1', partType: 'tool', toolName: 'delegate' },
      { type: 'part_patch', key: 'call-1', args: { task: 'weather' } },
      { type: 'part_start', key: 'sub', partType: 'text', parent: 'call-1' },
      { type: 'delta', key: 'sub', text: 'Ankara 23°C' },
      { type: 'delta', key: 'root', text: 'done' },
      // a SECOND root lane opened while the first still streams — plural in-flight parts
      { type: 'part_start', key: 'root2', partType: 'reasoning' },
      { type: 'delta', key: 'root2', text: 'hmm' },
    )
    await w.flush()

    await waitFor(() => {
      const parts = feed.rows().find((r) => r.id === w.messageId)?.parts
      return parts?.length === 4 && parts.every((p) => p.type === 'tool' || p.text.length > 0)
    })
    const parts = feed.rows().find((r) => r.id === w.messageId)!.parts!
    // tree order: root text, then the delegate tool immediately followed by its subagent lane, then root2
    expect(parts.map((p) => [p.type, p.parent ?? null, p.text])).toEqual([
      ['text', null, 'delegating… done'],
      ['tool', null, ''],
      ['text', 'call-1', 'Ankara 23°C'],
      ['reasoning', null, 'hmm'],
    ])
    await w.finalize()
    annChat.close()
    ann.c.close()
  })

  it('a late-joining store reconstructs from checkpoints alone, then keeps splicing live', async () => {
    const { url } = await boot({ streaming: { checkpointMs: 10 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    const bobChat = chatClient(bob.c, { userId: bob.userId })
    await Promise.all([annChat.ready, bobChat.ready])
    const ch = await annChat.createChannel({ name: 'general' })
    await bobChat.join(ch.id)

    const w = await annChat.stream(ch.id)
    w.push({ type: 'part_start', key: 't', partType: 'text' }, { type: 'delta', key: 't', text: 'partial ' })
    await w.flush()
    await sleep(30) // let the checkpoint land

    // bob opens the feed only NOW — everything he sees came from rows
    const feed = bobChat.messages(ch.id)
    await feed.ready
    await waitFor(() => (feed.rows().find((r) => r.id === w.messageId)?.parts?.[0]?.text.length ?? 0) > 0)

    // …and the stream continues live into the same store
    w.push({ type: 'delta', key: 't', text: 'stream' })
    await w.flush()
    await waitFor(() => feed.rows().find((r) => r.id === w.messageId)?.parts?.[0]?.text === 'partial stream')

    await w.finalize()
    annChat.close()
    bobChat.close()
    ann.c.close()
    bob.c.close()
  })

  it('the parts window is recency-bounded: an old turn assembles without parts, its content still renders', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    // partsLimit 2: only the two most-recently-active parts stay in the window
    const annChat = chatClient(ann.c, { userId: ann.userId, partsLimit: 2 })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'general' })

    const a = await annChat.stream(ch.id)
    a.push(
      { type: 'part_start', key: 't', partType: 'text' },
      { type: 'delta', key: 't', text: 'old turn' },
      { type: 'part_end', key: 't' },
    )
    await a.finalize()
    const b = await annChat.stream(ch.id)
    b.push(
      { type: 'part_start', key: 't', partType: 'text' },
      { type: 'delta', key: 't', text: 'new turn' },
      { type: 'part_end', key: 't' },
      { type: 'part_start', key: 'r', partType: 'reasoning' },
      { type: 'delta', key: 'r', text: 'thinking' },
      { type: 'part_end', key: 'r' },
    )
    await b.finalize()

    const feed = annChat.messages(ch.id)
    await feed.ready
    await waitFor(() => (feed.rows().find((r) => r.id === b.messageId)?.parts?.length ?? 0) === 2)
    const oldTurn = feed.rows().find((r) => r.id === a.messageId)!
    expect(oldTurn.parts).toBeUndefined() // fell out of the window — not an empty array, ABSENT
    expect(oldTurn).toMatchObject({ status: 'complete', content: 'old turn' }) // content carries the render
    annChat.close()
    ann.c.close()
  })

  it('a push after finalize starts is a true no-op; finalize is memoized; a huge push is sliced under the server cap', async () => {
    const { url } = await boot({ streaming: { maxEventsPerAppend: 100 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'general' })

    // one push of 151 events (1 part_start + 150 deltas) — must be sliced into ≤100-event batches
    const w = await annChat.stream(ch.id)
    w.push(
      { type: 'part_start', key: 't', partType: 'text' },
      ...Array.from({ length: 150 }, (): { type: 'delta'; key: string; text: string } => ({
        type: 'delta',
        key: 't',
        text: 'x',
      })),
    )
    const settle = w.finalize() // closing flips synchronously…
    w.push({ type: 'delta', key: 't', text: 'LATE' }) // …so this is a no-op, not silently-dropped-later
    const done = await settle
    expect(done.content).toBe('x'.repeat(150)) // all 150 landed (sliced), LATE did not

    const again = await w.finalize() // memoized — same settle, no CONFLICT
    expect(again).toBe(done)
    await w.abort() // after a settle: no-op
    annChat.close()
    ann.c.close()
  })

  it('writer failures surface at flush/finalize; abort after a server-side settle is a safe no-op', async () => {
    const { url } = await boot({ streaming: { maxParts: 1 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'general' })
    const feed = annChat.messages(ch.id)
    await feed.ready

    const w = await annChat.stream(ch.id)
    w.push({ type: 'part_start', key: 'a', partType: 'text' })
    await w.flush()
    w.push({ type: 'part_start', key: 'b', partType: 'text' }) // over the cap — server aborts the stream
    await expect(w.flush()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(w.finalize()).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await w.abort() // already settled server-side → CONFLICT swallowed

    await waitFor(() => feed.rows().find((r) => r.id === w.messageId)?.status === 'aborted')
    annChat.close()
    ann.c.close()
  })
})
