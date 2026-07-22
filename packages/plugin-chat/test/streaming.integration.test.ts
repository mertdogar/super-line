import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, SuperLineError } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import type { ChatMessage, ChatMessagePart } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import type { ChatHooks, ChatStreamingOptions } from '@super-line/plugin-chat/server'
import { createHarness, waitFor } from '../../server/test/harness.js'

const app = defineContract({
  roles: {
    user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract(), chatContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function boot(opts?: { hooks?: ChatHooks; streaming?: ChatStreamingOptions }) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({
    contract: app,
    ...(opts?.hooks ? { hooks: opts.hooks } : {}),
    ...(opts?.streaming ? { streaming: opts.streaming } : {}),
  })
  const { srv, url } = await h.server(app, {
    nodeKey: 'chat-streaming-test',
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

const sorted = (rows: readonly unknown[], messageId: string): ChatMessagePart[] =>
  (rows as ChatMessagePart[]).filter((p) => p.messageId === messageId).sort((a, b) => a.idx - b.idx)

describe('plugin-chat — streaming messages', () => {
  it('start → append → finalize: parts rows, envelope projection, and both hook points fire', async () => {
    const calls: string[] = []
    const { url } = await boot({
      hooks: {
        startMessage: {
          before: (input, initiator) => void calls.push(`start.before:${initiator.kind}`),
          after: (m, initiator) => void calls.push(`start.after:${initiator.kind}:${m.status}`),
        },
        finalizeMessage: {
          after: (m, initiator) => void calls.push(`finalize.after:${initiator.kind}:${m.status}:${m.parts.length}`),
        },
      },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })

    const msg = await ann.c.startMessage({ channelId: ch.id })
    expect(msg).toMatchObject({ channelId: ch.id, authorId: ann.userId, status: 'streaming' })
    expect(msg.content).toBeUndefined()

    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't1', partType: 'text' },
        { type: 'delta', key: 't1', text: 'Hello ' },
        { type: 'delta', key: 't1', text: 'world' },
        { type: 'part_end', key: 't1' },
      ],
    })

    const parts = ann.c.collection('messageParts').subscribe({})
    await parts.ready
    await waitFor(() => sorted(parts.rows(), msg.id).some((p) => p.done))
    expect(sorted(parts.rows(), msg.id)).toMatchObject([
      { idx: 0, type: 'text', parent: null, text: 'Hello world', offset: 11, done: true },
    ])

    const done = await ann.c.finalizeMessage({ id: msg.id })
    expect(done).toMatchObject({ id: msg.id, status: 'complete', content: 'Hello world' })

    const messages = ann.c.collection('messages').subscribe({})
    await messages.ready
    await waitFor(() => (messages.rows() as ChatMessage[]).some((m) => m.status === 'complete'))
    expect((messages.rows() as ChatMessage[])[0]).toMatchObject({ content: 'Hello world', status: 'complete' })

    expect(calls).toEqual([
      'start.before:client',
      'start.after:client:streaming',
      'finalize.after:client:complete:1',
    ])
    ann.c.close()
  })

  it('deltas reach a watching member live, offsets contiguous, before any checkpoint lands', async () => {
    // checkpoint far away → everything observed here rode the ephemeral room, not rows
    const { url } = await boot({ streaming: { checkpointMs: 60_000 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'general' })
    await bob.c.joinChannel({ channelId: ch.id })

    const deltas: { messageId: string; partIdx: number; offset: number; text: string }[] = []
    bob.c.on('chat.streamDelta', (d) => void deltas.push(d as never))
    await bob.c.watchChannel({ channelId: ch.id })

    const msg = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'strea' },
        { type: 'delta', key: 't', text: 'ming' },
      ],
    })

    await waitFor(() => deltas.length === 2)
    expect(deltas[0]).toMatchObject({ channelId: ch.id, messageId: msg.id, partIdx: 0, offset: 0, text: 'strea' })
    expect(deltas[1]).toMatchObject({ offset: 5, text: 'ming' })

    // the row exists (part_start persists immediately) but its text is still empty — no checkpoint yet
    const parts = bob.c.collection('messageParts').subscribe({})
    await parts.ready
    expect(sorted(parts.rows(), msg.id)).toMatchObject([{ idx: 0, text: '', offset: 0, done: false }])

    await ann.c.finalizeMessage({ id: msg.id })
    ann.c.close()
    bob.c.close()
  })

  it('late joiner reconstructs from checkpoints: accumulated text lands on the row without finalize', async () => {
    const { url } = await boot({ streaming: { checkpointMs: 10 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })

    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'partial ' },
      ],
    })
    await sleep(25) // > checkpointMs — the next delta (or the trailing flush) checkpoints
    await ann.c.appendMessage({ id: msg.id, events: [{ type: 'delta', key: 't', text: 'stream' }] })

    // a LATE member joins mid-stream and sees the checkpointed prefix from rows alone
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    await bob.c.joinChannel({ channelId: ch.id })
    const parts = bob.c.collection('messageParts').subscribe({})
    await parts.ready
    await waitFor(() => {
      const p = sorted(parts.rows(), msg.id)[0]
      return p?.type === 'text' && p.text.length > 0 && p.offset === p.text.length
    })
    const seen = sorted(parts.rows(), msg.id)[0]!
    if (seen.type !== 'text') throw new Error('expected text part')
    expect('partial stream'.startsWith(seen.text)).toBe(true)

    // the trailing flush checkpoints the tail even with no further deltas
    await waitFor(() => {
      const part = sorted(parts.rows(), msg.id)[0]
      return part?.type === 'text' && part.text === 'partial stream'
    })
    await ann.c.finalizeMessage({ id: msg.id })
    ann.c.close()
    bob.c.close()
  })

  it('watch requires membership; parts rows are membership-RLS-scoped', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const mallory = await newUser(url, 'mal@x.com', 'Mallory')
    const secret = await ann.c.createChannel({ name: 'secret', visibility: 'private' })

    await expect(mallory.c.watchChannel({ channelId: secret.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const msg = await ann.c.startMessage({ channelId: secret.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'classified' },
        { type: 'part_end', key: 't' },
      ],
    })
    await ann.c.finalizeMessage({ id: msg.id })

    const spy = mallory.c.collection('messageParts').subscribe({})
    await spy.ready
    expect(sorted(spy.rows(), msg.id)).toEqual([])
    ann.c.close()
    mallory.c.close()
  })

  it('author-only writes; append after settle CONFLICTs', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'general' })
    await bob.c.joinChannel({ channelId: ch.id })

    const msg = await ann.c.startMessage({ channelId: ch.id })
    const steal = { id: msg.id, events: [{ type: 'part_start', key: 'x', partType: 'text' }] } as const
    await expect(bob.c.appendMessage(steal as never)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(bob.c.finalizeMessage({ id: msg.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await ann.c.finalizeMessage({ id: msg.id })
    await expect(ann.c.appendMessage(steal as never)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(ann.c.finalizeMessage({ id: msg.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    ann.c.close()
    bob.c.close()
  })

  it('disconnect mid-stream aborts: partial content preserved, finalize.after fires with initiator server', async () => {
    const settled: string[] = []
    const { url, chatKit } = await boot({
      hooks: {
        finalizeMessage: { after: (m, initiator) => void settled.push(`${initiator.kind}:${m.status}:${m.error}`) },
      },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'interrupted thought' },
      ],
    })
    ann.c.close() // abrupt drop — no finalize

    await waitFor(async () => {
      const [m] = await chatKit.messages.find()
      return m?.status === 'aborted'
    })
    const [m] = await chatKit.messages.find()
    expect(m).toMatchObject({ status: 'aborted', error: 'author disconnected', content: 'interrupted thought' })
    const parts = await chatKit.messages.partsOf(msg.id)
    expect(parts).toMatchObject([{ text: 'interrupted thought', done: true }])
    expect(settled).toEqual(['server:aborted:author disconnected'])
  })

  it('subagent trees: parts nest under a delegate tool part; unknown parent rejected; lanes interleave', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'ops' })
    const msg = await ann.c.startMessage({ channelId: ch.id })

    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 'root-t', partType: 'text' },
        { type: 'delta', key: 'root-t', text: 'delegating… ' },
        { type: 'part_start', key: 'call-1', partType: 'tool', toolName: 'delegate' },
        { type: 'tool_patch', key: 'call-1', args: { task: 'check weather' } },
        // the worker's lane, nested under the delegate call — interleaved with root deltas
        { type: 'part_start', key: 'sub-t', partType: 'text', parent: 'call-1' },
        { type: 'delta', key: 'sub-t', text: 'Ankara: 23°C' },
        { type: 'delta', key: 'root-t', text: 'still supervising' },
        { type: 'part_end', key: 'sub-t' },
        { type: 'tool_patch', key: 'call-1', result: { report: 'mild' } },
        { type: 'part_end', key: 'root-t' },
      ],
    })

    await expect(
      ann.c.appendMessage({
        id: msg.id,
        events: [{ type: 'part_start', key: 'orphan', partType: 'text', parent: 'nope' }],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    const done = await ann.c.finalizeMessage({ id: msg.id })
    // root-lane projection only — the subagent's text is not the message's content
    expect(done.content).toBe('delegating… still supervising')

    const parts = ann.c.collection('messageParts').subscribe({})
    await parts.ready
    const rows = sorted(parts.rows(), msg.id)
    expect(rows).toMatchObject([
      { idx: 0, type: 'text', parent: null, text: 'delegating… still supervising' },
      { idx: 1, type: 'tool', parent: null, toolCallId: 'call-1', toolName: 'delegate', state: 'done', result: { report: 'mild' } },
      { idx: 2, type: 'text', parent: 'call-1', text: 'Ankara: 23°C' },
    ])
    ann.c.close()
  })

  it('tool lifecycle: input-streaming → running → done; deltas on tool parts are rejected', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })
    const parts = ann.c.collection('messageParts').subscribe({})
    await parts.ready

    await ann.c.appendMessage({
      id: msg.id,
      events: [{ type: 'part_start', key: 'call-9', partType: 'tool', toolName: 'weather' }],
    })
    await waitFor(() => sorted(parts.rows(), msg.id).length === 1)
    expect(sorted(parts.rows(), msg.id)[0]).toMatchObject({ state: 'input-streaming', done: false })

    await expect(
      ann.c.appendMessage({ id: msg.id, events: [{ type: 'delta', key: 'call-9', text: '{"city":' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    await ann.c.appendMessage({ id: msg.id, events: [{ type: 'tool_patch', key: 'call-9', args: { city: 'Ankara' } }] })
    await waitFor(() => {
      const part = sorted(parts.rows(), msg.id)[0]
      return part?.type === 'tool' && part.state === 'running'
    })

    await ann.c.appendMessage({
      id: msg.id,
      events: [{ type: 'tool_patch', key: 'call-9', result: { temp: 23 }, isError: false }],
    })
    await waitFor(() => {
      const part = sorted(parts.rows(), msg.id)[0]
      return part?.type === 'tool' && part.state === 'done'
    })
    expect(sorted(parts.rows(), msg.id)[0]).toMatchObject({ args: { city: 'Ankara' }, result: { temp: 23 }, isError: false })

    await ann.c.finalizeMessage({ id: msg.id })
    ann.c.close()
  })

  it('caps: exceeding maxParts settles the stream as aborted and surfaces the violation', async () => {
    const settled: string[] = []
    const { url, chatKit } = await boot({
      streaming: { maxParts: 2 },
      hooks: { finalizeMessage: { after: (m) => void settled.push(`${m.status}`) } },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })

    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 'a', partType: 'text' },
        { type: 'part_start', key: 'b', partType: 'text' },
      ],
    })
    await expect(
      ann.c.appendMessage({ id: msg.id, events: [{ type: 'part_start', key: 'c', partType: 'text' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    const [m] = await chatKit.messages.find()
    expect(m?.status).toBe('aborted')
    expect(settled).toEqual(['aborted'])
    await expect(
      ann.c.appendMessage({ id: msg.id, events: [{ type: 'delta', key: 'a', text: 'x' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    ann.c.close()
  })

  it('kit writer streams with server initiator; abort is the kill-switch; sweepStale repairs orphans', async () => {
    const { url, srv, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })

    const writer = await chatKit.messages.stream({ channelId: ch.id, authorId: ann.userId })
    await writer.push(
      { type: 'part_start', key: 't', partType: 'text' },
      { type: 'delta', key: 't', text: 'server-side turn' },
    )
    const killed = await chatKit.messages.abort(writer.messageId, 'operator killed it')
    expect(killed).toMatchObject({ status: 'aborted', error: 'operator killed it', content: 'server-side turn' })

    // a crashed node's orphan: a 'streaming' envelope this node has NO live stream for
    const orphanId = 'orphan-1'
    await srv.collection('messages').insert({
      id: orphanId,
      channelId: ch.id,
      authorId: ann.userId,
      createdAt: Date.now() - 60_000,
      editedAt: null,
      status: 'streaming',
    })
    // a LIVE stream must survive the sweep
    const live = await chatKit.messages.stream({ channelId: ch.id, authorId: ann.userId })

    const swept = await chatKit.messages.sweepStale({ olderThanMs: 5_000 })
    expect(swept.map((m) => m.id)).toEqual([orphanId])
    expect(swept[0]).toMatchObject({ status: 'aborted' })
    const rows = (await chatKit.messages.find()) as ChatMessage[]
    expect(rows.find((m) => m.id === live.messageId)?.status).toBe('streaming')
    await live.finalize()
    ann.c.close()
  })

  it('deleteChannel cascades parts and drops open streams; deleteMessage cascades its parts', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'doomed' })

    const finished = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({
      id: finished.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'kept?' },
        { type: 'part_end', key: 't' },
      ],
    })
    await ann.c.finalizeMessage({ id: finished.id })

    const open = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({ id: open.id, events: [{ type: 'part_start', key: 't', partType: 'text' }] })

    await ann.c.deleteChannel({ id: ch.id })
    expect(await chatKit.messages.find()).toEqual([])
    expect(await chatKit.messages.partsOf(finished.id)).toEqual([])
    expect(await chatKit.messages.partsOf(open.id)).toEqual([])
    await expect(
      ann.c.appendMessage({ id: open.id, events: [{ type: 'delta', key: 't', text: 'x' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // deleteMessage cascade, in a fresh channel
    const ch2 = await ann.c.createChannel({ name: 'second' })
    const msg = await ann.c.startMessage({ channelId: ch2.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'gone soon' },
        { type: 'part_end', key: 't' },
      ],
    })
    await ann.c.finalizeMessage({ id: msg.id })
    await ann.c.deleteMessage({ id: msg.id })
    expect(await chatKit.messages.partsOf(msg.id)).toEqual([])
    ann.c.close()
  })
})

describe('plugin-chat — streaming review hardening', () => {
  it('an oversize append batch aborts the stream like every other cap', async () => {
    const { url, chatKit } = await boot({ streaming: { maxEventsPerAppend: 2 } })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })
    await expect(
      ann.c.appendMessage({
        id: msg.id,
        events: [
          { type: 'part_start', key: 'a', partType: 'text' },
          { type: 'delta', key: 'a', text: 'x' },
          { type: 'delta', key: 'a', text: 'y' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const [m] = await chatKit.messages.find()
    expect(m?.status).toBe('aborted') // not a phantom open stream
    ann.c.close()
  })

  it('toolName is dropped from non-tool parts; tool state never regresses behind a landed result', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text', toolName: 'sneaky' } as never,
        { type: 'part_start', key: 'c1', partType: 'tool', toolName: 'weather' },
        { type: 'tool_patch', key: 'c1', result: { ok: true } },
        { type: 'tool_patch', key: 'c1', state: 'running' }, // stale out-of-order patch
      ],
    })
    const parts = ann.c.collection('messageParts').subscribe({})
    await parts.ready
    await waitFor(() => sorted(parts.rows(), msg.id).length === 2)
    const [textPart, toolPart] = sorted(parts.rows(), msg.id)
    expect('toolName' in textPart!).toBe(false)
    expect(toolPart).toMatchObject({ state: 'done', result: { ok: true } })
    await ann.c.finalizeMessage({ id: msg.id })
    ann.c.close()
  })

  it('a throwing finalizeMessage.before gates client finalize but can NOT block disconnect cleanup', async () => {
    const settled: string[] = []
    const { url, chatKit } = await boot({
      hooks: {
        finalizeMessage: {
          before: () => {
            throw new SuperLineError('FORBIDDEN', 'vetoed')
          },
          after: (m) => void settled.push(m.status ?? '?'),
        },
      },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'partial' },
      ],
    })
    // the veto DOES gate the author's own finalize (intent)…
    await expect(ann.c.finalizeMessage({ id: msg.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // …but cleanup is unvetoable: disconnect force-aborts straight through it
    ann.c.close()
    await waitFor(async () => (await chatKit.messages.find())[0]?.status === 'aborted')
    const [m] = await chatKit.messages.find()
    expect(m).toMatchObject({ status: 'aborted', content: 'partial' })
    expect(settled).toEqual(['aborted']) // after still fired — audit missed nothing
  })

  it('graceful server close drains open streams instead of stranding streaming rows', async () => {
    const { url, srv, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.startMessage({ channelId: ch.id })
    await ann.c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'shutting down' },
      ],
    })
    await srv.close()
    const [m] = await chatKit.messages.find()
    expect(m).toMatchObject({ status: 'aborted', error: 'server shutdown', content: 'shutting down' })
    void msg
  })
})

describe('plugin-chat — streaming with a structured content schema', () => {
  const richContent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('link'), url: z.string() }),
  ])
  const richApp = defineContract({
    roles: {
      user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
    },
    plugins: [authContract(), chatContract({ content: richContent })],
  })

  async function bootRich(streaming?: ChatStreamingOptions) {
    const backend = memoryCollections()
    const authKit = auth({ contract: richApp, collections: backend, defaultRoles: ['user'] })
    const chatKit = chat({ contract: richApp, ...(streaming ? { streaming } : {}) })
    const { srv, url } = await h.server(richApp, {
      nodeKey: 'chat-streaming-rich-test',
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin, chatKit.plugin],
    })
    srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)
    const g = h.client(richApp, { url, role: 'guest' })
    const { token, userId } = await g.signUp({ email: 'ann@x.com', password: 'passpass', displayName: 'Ann' })
    g.close()
    const c = h.client(richApp, { url, role: 'user', params: { token } })
    return { c, userId, chatKit }
  }

  const streamOne = async (c: { [k: string]: any }) => {
    const ch = await c.createChannel({ name: 'general' })
    const msg = await c.startMessage({ channelId: ch.id })
    await c.appendMessage({
      id: msg.id,
      events: [
        { type: 'part_start', key: 't', partType: 'text' },
        { type: 'delta', key: 't', text: 'rich world' },
        { type: 'part_end', key: 't' },
      ],
    })
    return msg
  }

  it('the default projection fails loudly WITH guidance — and the message still settles', async () => {
    const { c, chatKit } = await bootRich()
    const msg = await streamOne(c)
    await expect(c.finalizeMessage({ id: msg.id })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('project'),
    })
    // settled (not a zombie 'streaming' row), content honestly absent
    const [m] = await chatKit.messages.find()
    expect(m?.status).toBe('complete')
    expect(m?.content).toBeUndefined()
    c.close()
  })

  it('a host-supplied project derives schema-valid content', async () => {
    const { c } = await bootRich({
      project: (parts) => ({
        type: 'text',
        text: parts.flatMap((p) => (p.type === 'text' && p.parent === null ? [p.text] : [])).join(''),
      }),
    })
    const msg = await streamOne(c)
    const done = await c.finalizeMessage({ id: msg.id })
    expect(done.content).toEqual({ type: 'text', text: 'rich world' })
    c.close()
  })
})

describe('plugin-chat — host-typed data parts', () => {
  const dataPayload = z.object({ kind: z.literal('progress'), value: z.number(), detail: z.string().optional() })
  const dataApp = defineContract({
    roles: {
      user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
    },
    plugins: [authContract(), chatContract({ data: dataPayload })],
  })

  async function bootData(streaming?: ChatStreamingOptions) {
    const backend = memoryCollections()
    const authKit = auth({ contract: dataApp, collections: backend, defaultRoles: ['user'] })
    const chatKit = chat({ contract: dataApp, ...(streaming ? { streaming } : {}) })
    const { srv, url } = await h.server(dataApp, {
      nodeKey: 'chat-streaming-data-test',
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin, chatKit.plugin],
    })
    srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)
    const guest = h.client(dataApp, { url, role: 'guest' })
    const { token } = await guest.signUp({ email: 'data@x.com', password: 'passpass', displayName: 'Data' })
    guest.close()
    return h.client(dataApp, { url, role: 'user', params: { token } })
  }

  it('validates, patches, and reloads custom data payloads', async () => {
    const client = await bootData()
    const channel = await client.createChannel({ name: 'data' })
    const message = await client.startMessage({ channelId: channel.id })
    await expect(
      client.appendMessage({
        id: message.id,
        events: [{ type: 'part_start', key: 'p', partType: 'data', data: { kind: 'progress', value: 'bad' } }],
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await client.appendMessage({
      id: message.id,
      events: [
        { type: 'part_start', key: 'p', partType: 'data', data: { kind: 'progress', value: 10 } },
        { type: 'data_patch', key: 'p', data: { kind: 'progress', value: 100 } },
        { type: 'part_end', key: 'p' },
      ],
    })
    await client.finalizeMessage({ id: message.id })
    const parts = client.collection('messageParts').subscribe({})
    await parts.ready
    expect(parts.rows()).toMatchObject([
      { type: 'data', data: { kind: 'progress', value: 100 }, done: true },
    ])
    client.close()
  })

  it('aborts a stream when a structured payload exceeds the configured byte limit', async () => {
    const client = await bootData({ maxStructuredBytes: 64 })
    const channel = await client.createChannel({ name: 'bounded-data' })
    const message = await client.startMessage({ channelId: channel.id })
    await expect(
      client.appendMessage({
        id: message.id,
        events: [
          {
            type: 'part_start',
            key: 'p',
            partType: 'data',
            data: { kind: 'progress', value: 1, detail: 'x'.repeat(128) },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const messages = client.collection('messages').subscribe({})
    await messages.ready
    await waitFor(() => (messages.rows() as ChatMessage[])[0]?.status === 'aborted')
    client.close()
  })
})
