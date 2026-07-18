// The Mastra hookup, specified harness-self-check style: STRUCTURAL fake agents (`{ id, stream }`
// generators — the reason MastraAgentLike is structural, the nominal Agent class has a #private
// field) drive the engine with zero API keys. The fakes simulate exactly what Mastra does around
// the delegate tool: emit `tool-call`, await the injected tool's execute(), emit `tool-result` —
// or fold a thrown execute() into a `tool-error` chunk.

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import type { ChatStreamEvent } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { mastraEngine, pipeMastraStream } from '@super-line/plugin-chat/mastra'
import type { ChunkLike, MastraAgentLike } from '@super-line/plugin-chat/mastra'
import { createHarness, waitFor } from '../../server/test/harness.js'

// ── fake-Mastra toolkit ──────────────────────────────────────────────────────────────────────────

const text = (t: string): ChunkLike => ({ type: 'text-delta', payload: { text: t } })
const reason = (t: string): ChunkLike => ({ type: 'reasoning-delta', payload: { text: t } })
const toolCall = (id: string, name: string, args?: unknown): ChunkLike => ({
  type: 'tool-call',
  payload: { toolCallId: id, toolName: name, args },
})
const toolResult = (id: string, result: unknown): ChunkLike => ({
  type: 'tool-result',
  payload: { toolCallId: id, result },
})
const errChunk = (m: string): ChunkLike => ({ type: 'error', payload: { error: m } })
const stepFinish: ChunkLike = { type: 'step-finish', payload: {} }

interface DelegateToolLike {
  execute(input: { agentType: string; task: string }, ctx: unknown): Promise<{ content: string; isError: boolean }>
}
interface SeenOpts {
  abortSignal?: AbortSignal
  requestContext?: unknown
  toolsets?: { chat?: { delegate?: DelegateToolLike } }
}

/** A structural fake agent; records every stream()'s options for assertions. */
function fakeAgent(
  id: string,
  gen: (input: unknown, opts: SeenOpts) => AsyncGenerator<ChunkLike>,
): MastraAgentLike & { seen: SeenOpts[] } {
  const seen: SeenOpts[] = []
  return {
    id,
    seen,
    stream: async (input: unknown, opts: SeenOpts) => {
      seen.push(opts)
      return { fullStream: gen(input, opts) }
    },
  }
}

/** What Mastra does around a delegate call: tool-call → execute → tool-result (or tool-error). */
async function* delegateVia(opts: SeenOpts, toolCallId: string, agentType: string, task: string): AsyncGenerator<ChunkLike> {
  yield toolCall(toolCallId, 'delegate', { agentType, task })
  try {
    const res = await opts.toolsets!.chat!.delegate!.execute({ agentType, task }, { agent: { toolCallId } })
    yield toolResult(toolCallId, res)
  } catch (err) {
    yield { type: 'tool-error', payload: { toolCallId, error: err } }
  }
}

function recordSink() {
  const events: ChatStreamEvent[] = []
  return { events, sink: { push: (...e: ChatStreamEvent[]): void => void events.push(...e) } }
}

const keysOf = (events: ChatStreamEvent[], type: ChatStreamEvent['type']): string[] =>
  events.filter((e) => e.type === type).map((e) => e.key)

// ── pipeMastraStream (the single-lane escape hatch) ─────────────────────────────────────────────

describe('plugin-chat/mastra — pipeMastraStream', () => {
  it('maps one lane: segmentation at tool boundaries, whole args, tail close, text return', async () => {
    const { events, sink } = recordSink()
    async function* gen(): AsyncGenerator<ChunkLike> {
      yield reason('hmm')
      yield text('checking ')
      yield toolCall('tc9', 'thermometer', { city: 'Oslo' })
      yield toolResult('tc9', { c: 4 })
      yield text('4C') // reopens a FRESH text part after the tool call
    }
    const { text: full, error } = await pipeMastraStream(sink, gen())
    expect(error).toBeUndefined()
    expect(full).toBe('checking 4C')
    expect(events).toEqual([
      { type: 'part_start', key: 'r0', partType: 'reasoning' },
      { type: 'delta', key: 'r0', text: 'hmm' },
      { type: 'part_start', key: 't1', partType: 'text' },
      { type: 'delta', key: 't1', text: 'checking ' },
      { type: 'part_end', key: 't1' },
      { type: 'part_end', key: 'r0' },
      { type: 'part_start', key: 'tc9', partType: 'tool', toolName: 'thermometer' },
      { type: 'part_patch', key: 'tc9', args: { city: 'Oslo' } },
      { type: 'part_patch', key: 'tc9', result: { c: 4 }, isError: false },
      { type: 'part_end', key: 'tc9' },
      { type: 'part_start', key: 't2', partType: 'text' },
      { type: 'delta', key: 't2', text: '4C' },
      { type: 'part_end', key: 't2' }, // the tail close — no explicit end chunk exists in Mastra
    ])
  })

  it('captures a turn-level error chunk instead of throwing', async () => {
    const { sink } = recordSink()
    async function* gen(): AsyncGenerator<ChunkLike> {
      yield text('partial')
      yield errChunk('rate limited')
    }
    const { error } = await pipeMastraStream(sink, gen())
    expect(error).toBe('rate limited')
  })
})

// ── mastraEngine ─────────────────────────────────────────────────────────────────────────────────

describe('plugin-chat/mastra — mastraEngine', () => {
  it('streams a full delegation: root lane s:, worker lane w:{tc}: nested under the EMITTED delegate part', async () => {
    const worker = fakeAgent('worker', async function* () {
      yield text('measuring ')
      yield toolCall('wtc1', 'thermometer', { city: 'X' })
      yield toolResult('wtc1', { c: 21 })
      yield text('21C')
    })
    const supervisor = fakeAgent('supervisor', async function* (_input, opts) {
      yield text('Let me check. ')
      yield* delegateVia(opts, 'tc1', 'worker', 'go measure')
      yield text('Done.')
    })
    const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })

    const { events, sink } = recordSink()
    const { text: full, error } = await engine.run(sink, 'hi')
    expect(error).toBeUndefined()
    expect(full).toBe('Let me check. Done.') // ROOT text only — the worker's is the tool result's story

    // the delegate part is emitted (never suppressed): it IS the anchor the child lane nests under
    const delegateStart = events.find((e) => e.type === 'part_start' && e.key === 's:tc1')
    expect(delegateStart).toMatchObject({ partType: 'tool', toolName: 'delegate' })
    expect(events).toContainEqual({ type: 'part_patch', key: 's:tc1', args: { agentType: 'worker', task: 'go measure' } })

    // every worker part carries the delegate part's key as parent
    const workerStarts = events.filter((e) => e.type === 'part_start' && e.key.startsWith('w:tc1:'))
    expect(workerStarts.length).toBe(3) // text, tool, text
    for (const s of workerStarts) expect(s).toMatchObject({ parent: 's:tc1' })

    // the worker's report lands as the delegate result
    expect(events).toContainEqual({
      type: 'part_patch',
      key: 's:tc1',
      result: { content: 'measuring 21C', isError: false },
      isError: false,
    })

    // ordering: worker events land BETWEEN the delegate part_start and its result patch
    const idx = (pred: (e: ChatStreamEvent) => boolean): number => events.findIndex(pred)
    const dStart = idx((e) => e.type === 'part_start' && e.key === 's:tc1')
    const wFirst = idx((e) => e.type === 'part_start' && e.key.startsWith('w:tc1:'))
    const dResult = idx((e) => e.type === 'part_patch' && e.key === 's:tc1' && 'result' in e)
    expect(dStart).toBeLessThan(wFirst)
    expect(wFirst).toBeLessThan(dResult)

    // options plumbing — the thin-glue contract: the engine passes ONLY what it owns (the turn
    // abort + the delegate toolset; requestContext when given). Agent config never crosses here.
    expect(Object.keys(supervisor.seen[0]!).sort()).toEqual(['abortSignal', 'toolsets'])
    expect(Object.keys(worker.seen[0]!).sort()).toEqual(['abortSignal']) // leaf: NO toolsets
    expect(supervisor.seen[0]!.toolsets?.chat?.delegate).toBeDefined()
    expect(worker.seen[0]!.abortSignal).toBe(supervisor.seen[0]!.abortSignal)
  })

  it('gates edges and depth as isError tool results; rejects unregistered edges and suppressing the delegate at construction', async () => {
    const worker = fakeAgent('worker', async function* (_i, opts) {
      // worker may delegate BACK to the supervisor, but depth 2 > maxDepth 1
      yield* delegateVia(opts, 'tc2', 'supervisor', 'go deeper')
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield* delegateVia(opts, 'tcA', 'nobody', 'x') // not an edge
      yield* delegateVia(opts, 'tcB', 'worker', 'y') // fine — but the worker's own hop trips the depth gate
    })
    const engine = mastraEngine({
      agent: supervisor,
      subagents: [{ agent: worker, delegatesTo: ['supervisor'] }],
      maxDepth: 1,
    })
    const { events, sink } = recordSink()
    await engine.run(sink, 'hi')

    const results = events.filter((e) => e.type === 'part_patch' && 'result' in e)
    expect(results).toContainEqual(
      expect.objectContaining({
        key: 's:tcA',
        result: { content: "'supervisor' may not delegate to 'nobody'", isError: true },
      }),
    )
    expect(results).toContainEqual(
      expect.objectContaining({
        key: 'w:tcB:tc2',
        result: { content: 'max delegation depth (1) reached', isError: true },
      }),
    )

    expect(() => mastraEngine({ agent: supervisor, delegatesTo: ['ghost'] })).toThrow(/unregistered agent 'ghost'/)
    expect(() => mastraEngine({ agent: supervisor, suppressTools: ['delegate'] })).toThrow(/anchor/)
    // duplicate ids would silently clobber each other in the registry — fail fast instead
    expect(() =>
      mastraEngine({ agent: supervisor, subagents: [{ agent: worker }, { agent: fakeAgent('worker', async function* () {}) }] }),
    ).toThrow(/duplicate agent ids/)
  })

  it("delegatesTo: true means every OTHER agent — never a self-edge the model could recurse into", async () => {
    const worker = fakeAgent('worker', async function* () {
      yield text('w')
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield* delegateVia(opts, 'tcSelf', 'supervisor', 'recurse!')
      yield* delegateVia(opts, 'tcOk', 'worker', 'fine')
    })
    const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }], delegatesTo: true })
    const { events, sink } = recordSink()
    await engine.run(sink, 'hi')
    expect(events).toContainEqual(
      expect.objectContaining({
        key: 's:tcSelf',
        result: { content: "'supervisor' may not delegate to 'supervisor'", isError: true },
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ key: 's:tcOk', result: { content: 'w', isError: false } }),
    )
  })

  it('suppresses user tools by name; a root error chunk is returned while a worker error becomes the delegate isError', async () => {
    const worker = fakeAgent('worker', async function* () {
      yield text('almost')
      yield errChunk('worker exploded')
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield toolCall('hid', 'secret_scratchpad', { note: 'internal' })
      yield toolResult('hid', { ok: true })
      yield* delegateVia(opts, 'tc1', 'worker', 'try')
      yield text('recovered')
      yield errChunk('root exploded')
    })
    const engine = mastraEngine({
      agent: supervisor,
      subagents: [{ agent: worker }],
      suppressTools: ['secret_scratchpad'],
    })
    const { events, sink } = recordSink()
    const { error } = await engine.run(sink, 'hi')

    expect(error).toBe('root exploded')
    expect(keysOf(events, 'part_start')).not.toContain('s:hid') // suppressed end to end
    expect(events).toContainEqual(
      expect.objectContaining({ key: 's:tc1', result: { content: 'worker exploded', isError: true } }),
    )
    expect(events).toContainEqual({ type: 'delta', key: expect.stringMatching(/^s:t\d+$/), text: 'recovered' })
  })

  it('a worker stream that THROWS closes its open segments best-effort and lands as tool-error on the delegate part', async () => {
    const worker = fakeAgent('worker', async function* () {
      yield text('started but')
      throw new Error('socket died')
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield* delegateVia(opts, 'tc1', 'worker', 'try')
      yield text('noted the failure')
    })
    const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })
    const { events, sink } = recordSink()
    const { error } = await engine.run(sink, 'hi')

    expect(error).toBeUndefined() // the root turn survives a delegate failure
    expect(events).toContainEqual({ type: 'part_end', key: expect.stringMatching(/^w:tc1:t\d+$/) }) // best-effort close
    expect(events).toContainEqual(
      expect.objectContaining({ key: 's:tc1', result: { error: 'socket died' }, isError: true }),
    )
  })

  it('fail-fast: a rejected sink flush at step-finish aborts EVERY lane, nested workers included', async () => {
    let workerTicks = 0
    const worker = fakeAgent('worker', async function* () {
      for (let i = 0; ; i++) {
        workerTicks++
        yield text(`tick${i} `)
        yield stepFinish // each step checkpoints the sink
        await new Promise((r) => setTimeout(r, 1))
      }
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield text('delegating ')
      yield* delegateVia(opts, 'tc1', 'worker', 'run forever')
    })
    const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })

    let flushes = 0
    const sink = {
      push: (): void => {},
      flush: (): Promise<void> =>
        ++flushes >= 3 ? Promise.reject(new Error('stream was killed server-side')) : Promise.resolve(),
    }
    // rejects even though the worker-lane failure funnels into a tool-error the root survives —
    // the recorded sink failure still fails the turn after the wind-down
    await expect(engine.run(sink, 'hi')).rejects.toThrow('stream was killed server-side')
    // the endless worker was CLOSED at the failing checkpoint (generator .return()), not run dry
    expect(workerTicks).toBe(3)
    // and the one turn-scoped signal — handed to both lanes — is aborted, so a real Mastra run
    // (which honors abortSignal) stops generating everywhere
    expect(worker.seen[0]!.abortSignal).toBe(supervisor.seen[0]!.abortSignal)
    expect(worker.seen[0]!.abortSignal!.aborted).toBe(true)
  })

  it('chains an external abortSignal and hands requestContext verbatim to every lane', async () => {
    const outer = new AbortController()
    let sawChainedAbort = false
    const worker = fakeAgent('worker', async function* () {
      yield text('w')
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield* delegateVia(opts, 'tc1', 'worker', 'go')
      outer.abort('user cancelled') // mid-stream: the turn's signal must flip WITH the caller's
      sawChainedAbort = opts.abortSignal?.aborted === true
      yield text('winding down')
    })
    const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })
    const { sink } = recordSink()
    const rc = { tier: 'smart' }
    await engine.run(sink, 'hi', { abortSignal: outer.signal, requestContext: rc })
    expect(supervisor.seen[0]!.requestContext).toBe(rc)
    expect(worker.seen[0]!.requestContext).toBe(rc)
    expect(sawChainedAbort).toBe(true)
  })
})

// ── respond() against a real server (loopback) ──────────────────────────────────────────────────

const app = defineContract({
  roles: { user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } } },
  plugins: [authContract(), chatContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

async function boot() {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app })
  const { url } = await h.server(app, {
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin, chatKit.plugin],
  }).then(({ srv, url }) => {
    srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)
    return { srv, url }
  })
  return { url }
}

async function newUser(url: string, email: string, name: string) {
  const g = h.client(app, { url, role: 'guest' })
  const { token, userId } = await g.signUp({ email, password: 'passpass', displayName: name })
  g.close()
  const c = h.client(app, { url, role: 'user', params: { token } })
  return { c, userId }
}

describe('plugin-chat/mastra — respond() end to end', () => {
  it('settles a delegation turn: parts rows land with the parent chain, projection from root text, tree survives reload', async () => {
    const { url } = await boot()
    const bot = await newUser(url, 'bot@x.com', 'Bot')
    const botChat = chatClient(bot.c, { userId: bot.userId })
    await botChat.ready
    const ch = await botChat.createChannel({ name: 'agents' })

    const worker = fakeAgent('worker', async function* () {
      yield text('21C in Oslo')
    })
    const supervisor = fakeAgent('supervisor', async function* (_i, opts) {
      yield text('Checking. ')
      yield* delegateVia(opts, 'tc1', 'worker', 'oslo weather')
      yield text('It is 21C.')
    })
    const engine = mastraEngine({ agent: supervisor, subagents: [{ agent: worker }] })

    const row = await engine.respond(botChat, ch.id, 'weather in oslo?')
    expect(row).toMatchObject({ status: 'complete', content: 'Checking. \n\nIt is 21C.' })

    // a FRESH client (the reload) reassembles the whole tree from rows alone
    const again = chatClient(bot.c, { userId: bot.userId })
    await again.ready
    const feed = again.messages(ch.id)
    await feed.ready
    await waitFor(() => (feed.rows()[0]?.parts?.length ?? 0) >= 4)
    const parts = feed.rows()[0]!.parts!
    const delegatePart = parts.find((p) => p.toolCallId === 's:tc1')
    expect(delegatePart).toMatchObject({ type: 'tool', toolName: 'delegate', parent: null })
    const workerText = parts.find((p) => p.parent === 's:tc1')
    expect(workerText).toMatchObject({ type: 'text', text: '21C in Oslo' })
    again.close()
    botChat.close()
    bot.c.close()
  })

  it('an empty turn is deleted, an errored turn is kept with status error', async () => {
    const { url } = await boot()
    const bot = await newUser(url, 'bot@x.com', 'Bot')
    const botChat = chatClient(bot.c, { userId: bot.userId })
    await botChat.ready
    const ch = await botChat.createChannel({ name: 'agents' })
    const feed = botChat.messages(ch.id)
    await feed.ready

    const silent = fakeAgent('supervisor', async function* () {})
    expect(await mastraEngine({ agent: silent }).respond(botChat, ch.id, 'hi')).toBeUndefined()

    const failing = fakeAgent('supervisor', async function* (): AsyncGenerator<ChunkLike> {
      yield text('partial ')
      yield errChunk('rate limited')
    })
    const row = await mastraEngine({ agent: failing }).respond(botChat, ch.id, 'hi')
    expect(row).toMatchObject({ status: 'error', error: 'rate limited' })

    await waitFor(() => feed.rows().length === 1) // the empty turn's row is gone, the errored one stays
    expect(feed.rows()[0]!.id).toBe(row!.id)
    botChat.close()
    bot.c.close()
  })
})
