// The Mastra hookup: plain Mastra Agents in, typed stream events out — the whole delegation tree
// included. `createMastraRunner` owns the registry/edges/depth gates, the per-call `delegate`
// tool (tools.ts — injected via `toolsets`, NEVER baked into the user's Agent, so agents stay
// pure), the fullStream drive loop (runNode), and the chunk mapper below. NOT ported: approvals,
// modes, suspension/resume, thread stores — that's the harness's cockpit; channels are the
// threads here and parts rows are the persistence.
//
// One deliberate divergence from the harness: the `delegate` tool part is always EMITTED, never
// suppressed. The harness suppresses it because its tree anchors children by nodeId; plugin-chat
// nests by `part_start.parent` naming an EXISTING tool part row — the delegate part IS the
// anchor. Renderers wanting a distinct card special-case `toolName === 'delegate'` client-side.

import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ChatStreamEvent, StreamEventSink } from './index.js'

// ── the chunk mapper (a direct port of super-harness's chunk-adapter) ───────────────────────────
//
// Maps one Mastra `fullStream` chunk to plugin-chat STREAM EVENTS for ONE lane: the same
// structural `ChunkLike` view, the same stateful per-lane mapper with a `suppressToolNames`
// mechanic, the same case vocabulary — only the OUTPUT vocabulary changed, from HarnessEvents to
// ChatStreamEvents (PLAN-chat-streaming decision 4). The same mapper runs at every depth, so a
// subagent's tool calls and text stream with full fidelity, exactly like the supervisor's.
//
// Two deliberate translations from the harness original:
// - harness accumulated ONE text/reasoning blob per node (interleaving in the UI via textOffset);
//   parts have no offsets, so this adapter SEGMENTS instead — a tool call closes the open
//   text/reasoning part and the next delta opens a fresh one. Same rendered order, simpler model.
// - `tool-call-delta` (streaming args text) maps to nothing: plugin-chat v1 lands tool args whole
//   via tool_patch. The case stays so the vocabulary keeps parity with the harness mapper.

/** Structural view of a fullStream chunk — the real Mastra ChunkType is assignable to this. */
export interface ChunkLike {
  type: string
  payload?: unknown
}

export interface LaneOptions {
  /** Prefix for every part key this lane emits — two lanes of one message must never collide. */
  prefix: string
  /** The delegating tool part (its stored toolCallId/key) this lane nests under; root lane omits. */
  parent?: string
}

export interface MappedDataPart<Data> {
  data: Data
}

export interface ChunkAdapterOptions<Data> extends LaneOptions {
  suppressTools?: readonly string[]
  /** Turn an SDK-specific chunk into one complete custom data part. */
  mapDataPart?: (chunk: ChunkLike) => MappedDataPart<Data> | undefined
  /** Observe chunks that are neither transcript content nor known framing. */
  onUnsupported?: (chunk: ChunkLike) => void
}

export interface ChunkAdapter<Data> {
  map(chunk: ChunkLike): ChatStreamEvent<Data>[]
  /** Close any still-open text/reasoning segment (call once when the lane's stream ends). */
  end(): ChatStreamEvent<Data>[]
  /** Set when the stream emitted a turn-level `error` chunk. */
  error: string | undefined
}

export function createChunkAdapter<Data = never>(options: ChunkAdapterOptions<Data>): ChunkAdapter<Data> {
  const suppressToolNames = new Set(options.suppressTools ?? [])
  const lane: LaneOptions = options
  const suppressed = new Set<string>()
  const startedTools = new Set<string>()
  const key = (id: string): string => `${lane.prefix}${id}`
  const parent = lane.parent !== undefined ? { parent: lane.parent } : {}

  // Segmented text/reasoning: one open part per kind at a time; a tool call closes both.
  let seq = 0
  let openText: string | undefined
  let openReasoning: string | undefined
  const closeSegments = (): ChatStreamEvent<Data>[] => {
    const out: ChatStreamEvent<Data>[] = []
    if (openText !== undefined) out.push({ type: 'part_end', key: openText })
    if (openReasoning !== undefined) out.push({ type: 'part_end', key: openReasoning })
    openText = openReasoning = undefined
    return out
  }

  const self: ChunkAdapter<Data> = { map, end: closeSegments, error: undefined }

  function map(chunk: ChunkLike): ChatStreamEvent<Data>[] {
    const p = (chunk.payload ?? {}) as Record<string, any>
    switch (chunk.type) {
      case 'text-delta': {
        if (!p.text) return []
        const out: ChatStreamEvent<Data>[] = []
        if (openText === undefined) {
          openText = key(`t${seq++}`)
          out.push({ type: 'part_start', key: openText, partType: 'text', ...parent })
        }
        out.push({ type: 'delta', key: openText, text: p.text })
        return out
      }
      case 'reasoning-delta': {
        if (!p.text) return []
        const out: ChatStreamEvent<Data>[] = []
        if (openReasoning === undefined) {
          openReasoning = key(`r${seq++}`)
          out.push({ type: 'part_start', key: openReasoning, partType: 'reasoning', ...parent })
        }
        out.push({ type: 'delta', key: openReasoning, text: p.text })
        return out
      }
      case 'tool-call-input-streaming-start': {
        if (suppressToolNames.has(p.toolName)) {
          suppressed.add(p.toolCallId)
          return []
        }
        startedTools.add(p.toolCallId)
        return [
          ...closeSegments(),
          { type: 'part_start', key: key(p.toolCallId), partType: 'tool', toolName: p.toolName, ...parent },
        ]
      }
      case 'tool-call-delta':
        // args don't stream in plugin-chat v1 — they land whole on `tool-call` (case kept for parity)
        return []
      case 'tool-call': {
        if (suppressToolNames.has(p.toolName)) {
          suppressed.add(p.toolCallId)
          return []
        }
        const start: ChatStreamEvent<Data>[] = startedTools.has(p.toolCallId)
          ? []
          : [
              ...closeSegments(),
              { type: 'part_start', key: key(p.toolCallId), partType: 'tool', toolName: p.toolName, ...parent },
            ]
        startedTools.add(p.toolCallId)
        return [...start, { type: 'tool_patch', key: key(p.toolCallId), args: p.args }]
      }
      case 'tool-result':
        if (suppressed.has(p.toolCallId)) return []
        return [
          { type: 'tool_patch', key: key(p.toolCallId), result: p.result, isError: !!p.isError },
          { type: 'part_end', key: key(p.toolCallId) },
        ]
      case 'tool-error':
        // A tool whose execute() threw — without this the call stays "running" in the card forever.
        if (suppressed.has(p.toolCallId)) return []
        return [
          { type: 'tool_patch', key: key(p.toolCallId), result: { error: errorMessage(p) }, isError: true },
          { type: 'part_end', key: key(p.toolCallId) },
        ]
      case 'error':
        self.error = errorMessage(p)
        return []
      case 'start':
      case 'step-start':
      case 'step-finish':
      case 'finish':
        return []
      default: {
        const mapped = options.mapDataPart?.(chunk)
        if (mapped) {
          const dataKey = key(`d${seq++}`)
          return [
            { type: 'part_start', key: dataKey, partType: 'data', data: mapped.data, ...parent },
            { type: 'part_end', key: dataKey },
          ]
        }
        options.onUnsupported?.(chunk)
        return []
      }
    }
  }

  return self
}

function errorMessage(p: Record<string, any>): string {
  const e = p.error ?? p
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return typeof e?.message === 'string' ? e.message : JSON.stringify(e)
}

// ── the drive loop (runNode's fold, minus the harness envelope) ──────────────────────────────────

async function drive<Data>(
  adapter: ChunkAdapter<Data>,
  stream: AsyncIterable<ChunkLike> | ReadableStream<ChunkLike>,
  sink: StreamEventSink<Data>,
  hooks?: { checkpoint?: () => Promise<void>; bail?: () => void },
): Promise<{ text: string }> {
  const iterable: AsyncIterable<ChunkLike> =
    Symbol.asyncIterator in stream ? (stream as AsyncIterable<ChunkLike>) : readAll(stream as ReadableStream<ChunkLike>)
  let text = ''
  try {
    for await (const chunk of iterable) {
      // A dead sink ends every lane at its next chunk — abortSignal alone can't be trusted to
      // (a producer that ignores it would keep streaming into no-op pushes forever).
      hooks?.bail?.()
      if (chunk.type === 'text-delta') {
        const t = (chunk.payload as { text?: string } | undefined)?.text
        if (t) text += t
      }
      const events = adapter.map(chunk)
      if (events.length > 0) await sink.push(...events)
      // Once per LLM step: surface a wire failure (kill-switch, cap violation, disconnect) NOW
      // instead of at finalize — the checkpoint's rejection aborts every in-flight lane.
      if (chunk.type === 'step-finish' && hooks?.checkpoint) await hooks.checkpoint()
    }
  } catch (err) {
    // Best-effort: close open segments so a crashed lane doesn't leave parts "running" forever.
    const tail = adapter.end()
    if (tail.length > 0) {
      try {
        await sink.push(...tail)
      } catch {
        // the sink is dead too — the throw below already carries the story
      }
    }
    throw err
  }
  const tail = adapter.end()
  if (tail.length > 0) await sink.push(...tail)
  return { text }
}

async function* readAll<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Pipe ONE Mastra `fullStream` into a plugin-chat stream writer — the single-lane escape hatch,
 * exact sibling of `pipeUIMessageStream` (custom loops, one agent, no delegation). For the full
 * supervisor/subagent wiring use {@link createMastraRunner}.
 *
 * It never settles the message: the producer owns `finalize`/`abort` (put them in a `finally`).
 * A turn-level `error` chunk is returned, not thrown — pass it to `finalize({ status: 'error' })`.
 */
export async function pipeMastraStream<Data = never>(
  sink: StreamEventSink<Data>,
  stream: AsyncIterable<ChunkLike> | ReadableStream<ChunkLike>,
  opts?: Omit<ChunkAdapterOptions<Data>, keyof LaneOptions> & { lane?: LaneOptions },
): Promise<{ text: string; error?: string }> {
  const adapter = createChunkAdapter({
    ...(opts?.lane ?? { prefix: '' }),
    ...(opts?.suppressTools ? { suppressTools: opts.suppressTools } : {}),
    ...(opts?.mapDataPart ? { mapDataPart: opts.mapDataPart } : {}),
    ...(opts?.onUnsupported ? { onUnsupported: opts.onUnsupported } : {}),
  })
  const { text } = await drive(adapter, stream, sink)
  return adapter.error !== undefined ? { text, error: adapter.error } : { text }
}

// ── the engine (createHarness, scoped to chat) ───────────────────────────────────────────────────

/**
 * Structural view of a Mastra `Agent` — nominal `Agent` has an ECMAScript private field, which
 * would make test fakes impossible to type. Real Agents satisfy this for free.
 */
export interface MastraAgentLike {
  /** Mastra `Agent.id` — the registry key `delegatesTo` edges and the delegate tool reference. */
  id: string
  stream(input: unknown, options?: unknown): Promise<{ fullStream: unknown }>
}

export interface MastraSubagent {
  agent: MastraAgentLike
  /** Who this agent may delegate to: agent ids, `true` = every registered agent. Default: none (leaf). */
  delegatesTo?: string[] | true
}

export interface MastraRunnerOptions<Data = never> {
  /** The root agent — every `run` drives it; subagents run under `delegate` calls. */
  agent: MastraAgentLike
  subagents?: MastraSubagent[]
  /** The root agent's delegation edges. Default: ALL subagents. */
  delegatesTo?: string[] | true
  /** Delegation depth cap (root = 0). Default 3. */
  maxDepth?: number
  /** Tool names to hide from the transcript entirely. `'delegate'` is rejected — see header. */
  suppressTools?: string[]
  /** Optional host mapping for Mastra chunks that should become durable custom data parts. */
  mapDataPart?: (chunk: ChunkLike) => MappedDataPart<Data> | undefined
  onUnsupported?: (chunk: ChunkLike) => void
}

export interface MastraRunOptions {
  abortSignal?: AbortSignal
  /**
   * A Mastra `RequestContext`, handed verbatim to every node's `stream()` — the one per-turn
   * conduit down the tree. Everything per-AGENT (maxSteps, provider options, memory) belongs on
   * the `Agent` itself via Mastra's `defaultOptions`, which may be a function of this context —
   * e.g. the root agent deriving `memory: { thread }` from a channel id set here.
   */
  requestContext?: unknown
}

export interface MastraRunner<Data = never> {
  /**
   * Stream one full turn — root lane plus every delegation, nested — into `sink`. Never settles
   * the message. A turn-level `error`
   * chunk on the ROOT lane is returned, not thrown; a subagent's failure becomes the delegate
   * tool's `isError` result and the root turn continues (the model sees it and may retry).
   */
  run(
    sink: StreamEventSink<Data>,
    input: unknown,
    opts?: MastraRunOptions,
  ): Promise<{ text: string; error?: string }>
}

const DELEGATE_TOOL = 'delegate'

/** The harness's delegate tool, chat-scoped: same shape ({ agentType, task } → { content, isError }). */
function makeDelegateTool(agentTypes: string[], run: (agentType: string, task: string, toolCallId: string) => Promise<{ content: string; isError: boolean }>) {
  return createTool({
    id: DELEGATE_TOOL,
    description:
      'Delegate a self-contained task to a subagent. It runs headless and returns a final report — you never see its intermediate tool calls. Pass the full context it needs.',
    inputSchema: z.object({
      agentType: z.string().describe(`Which subagent to run. One of: ${agentTypes.join(', ')}`),
      task: z.string().describe('The complete task/brief for the subagent.'),
    }),
    outputSchema: z.object({ content: z.string(), isError: z.boolean() }),
    execute: async ({ agentType, task }, ctx) => {
      const c = ctx as { agent?: { toolCallId?: string } } | undefined
      const toolCallId = c?.agent?.toolCallId ?? `${agentType}:${task.length}`
      return run(agentType, task, toolCallId)
    },
  })
}

/**
 * Wire plain Mastra Agents to plugin-chat streaming — the chat-scoped `createHarness`.
 *
 * ```ts
 * const runner = createMastraRunner({ agent: supervisor, subagents: [{ agent: worker }] })
 * const result = await runner.run(messageWriter, input, { abortSignal })
 * ```
 *
 * The engine owns everything the chat-supervisor example used to hand-roll: the `delegate` tool
 * (injected per stream call via `toolsets` — your agents never declare it), delegation edges and
 * the depth gate, lane key namespacing (root `s:`, each subagent `w:{toolCallId}:` nested under
 * its delegate part), the chunk mapping, tail flushes, and error propagation. Abort is one
 * mechanism: `opts.abortSignal` and a rejected sink `flush()` (checked once per LLM step, when the
 * sink has one — `ChatStreamHandle` does) both cancel every in-flight lane at every depth.
 *
 * And it owns NOTHING else: agents arrive fully configured. `maxSteps`, provider options
 * (thinking), and memory are the host's `Agent` `defaultOptions` — a function of the
 * `requestContext` the engine forwards, so e.g. only the root agent derives a per-channel
 * `memory: { thread }` and workers stay stateless by construction, not by engine policy.
 */
export function createMastraRunner<Data = never>(cfg: MastraRunnerOptions<Data>): MastraRunner<Data> {
  const subs = cfg.subagents ?? []
  const known = new Set<string>([cfg.agent.id, ...subs.map((s) => s.agent.id)])
  if (known.size !== subs.length + 1)
    throw new Error('duplicate agent ids — every agent in a Mastra runner needs a distinct `id`')
  const resolveEdges = (d: string[] | true | undefined, fallback: string[], ownId: string): string[] => {
    // `true` = every OTHER agent — a self-edge would let the model recurse into itself to maxDepth
    const edges = d === true ? [...known].filter((id) => id !== ownId) : (d ?? fallback)
    for (const t of edges) if (!known.has(t)) throw new Error(`delegatesTo references unregistered agent '${t}'`)
    return edges
  }
  const suppress: ReadonlySet<string> = new Set(cfg.suppressTools ?? [])
  if (suppress.has(DELEGATE_TOOL))
    throw new Error(`'${DELEGATE_TOOL}' cannot be suppressed — its tool part is the anchor child lanes nest under`)
  const maxDepth = cfg.maxDepth ?? 3

  interface Entry {
    agent: MastraAgentLike
    delegatesTo: string[]
  }
  const registry = new Map<string, Entry>()
  registry.set(cfg.agent.id, {
    agent: cfg.agent,
    delegatesTo: resolveEdges(cfg.delegatesTo, subs.map((s) => s.agent.id), cfg.agent.id),
  })
  for (const s of subs)
    registry.set(s.agent.id, {
      agent: s.agent,
      delegatesTo: resolveEdges(s.delegatesTo, [], s.agent.id),
    })

  async function run(
    sink: StreamEventSink<Data>,
    input: unknown,
    opts?: MastraRunOptions,
  ): Promise<{ text: string; error?: string }> {
    // One turn-scoped controller: the caller's signal chains in, a failed checkpoint fires it, and
    // EVERY node's stream (root and each delegation, at every depth) receives it — the harness
    // threads its per-turn signal identically, and without it a killed turn keeps the workers
    // streaming into a dead sink.
    const abort = new AbortController()
    const chain = (): void => abort.abort(opts?.abortSignal?.reason)
    if (opts?.abortSignal?.aborted) chain()
    else opts?.abortSignal?.addEventListener('abort', chain, { once: true })
    // A sink failure is TERMINAL for the whole turn — but it can surface inside a WORKER lane,
    // where Mastra folds the throw into a tool-error chunk and the root lane winds down
    // gracefully. Record it here so run() still rejects after the wind-down.
    let failed: Error | undefined
    const bail = (): void => {
      if (failed !== undefined) throw failed
    }
    const flushable = sink as StreamEventSink<Data> & { flush?: () => Promise<void> }
    const checkpoint =
      typeof flushable.flush === 'function'
        ? async (): Promise<void> => {
            try {
              await flushable.flush!()
            } catch (err) {
              failed = err instanceof Error ? err : new Error(String(err))
              abort.abort(err)
              throw failed
            }
          }
        : undefined

    async function runLane(
      entry: Entry,
      laneInput: unknown,
      lane: LaneOptions,
      depth: number,
    ): Promise<{ text: string; error?: string }> {
      const adapter = createChunkAdapter<Data>({
        ...lane,
        suppressTools: [...suppress],
        ...(cfg.mapDataPart ? { mapDataPart: cfg.mapDataPart } : {}),
        ...(cfg.onUnsupported ? { onUnsupported: cfg.onUnsupported } : {}),
      })
      // The engine passes ONLY what it owns: the turn abort, the per-turn context conduit, and
      // the delegate toolset. Per-agent config (maxSteps, thinking, memory) is the host's Agent
      // `defaultOptions` — Mastra deep-merges those under these call options.
      const streamOpts: Record<string, unknown> = { abortSignal: abort.signal }
      if (opts?.requestContext !== undefined) streamOpts.requestContext = opts.requestContext
      if (entry.delegatesTo.length > 0) {
        const delegate = makeDelegateTool(entry.delegatesTo, (agentType, task, toolCallId) =>
          spawn(entry, agentType, task, toolCallId, lane, depth),
        )
        streamOpts.toolsets = { chat: { [DELEGATE_TOOL]: delegate } }
      }
      const { fullStream } = await entry.agent.stream(laneInput, streamOpts)
      const { text } = await drive(adapter, fullStream as AsyncIterable<ChunkLike> | ReadableStream<ChunkLike>, sink, {
        checkpoint,
        bail,
      })
      return adapter.error !== undefined ? { text, error: adapter.error } : { text }
    }

    // The harness's #spawnChild: gate the edge and the depth, then stream the child INTO THE SAME
    // message, its lane nested under this delegate call's tool part. A thrown child failure
    // propagates out of the tool's execute() — Mastra folds it into a `tool-error` chunk on the
    // parent stream, which the parent's adapter lands on the delegate part as an isError result.
    async function spawn(
      parent: Entry,
      agentType: string,
      task: string,
      toolCallId: string,
      parentLane: LaneOptions,
      parentDepth: number,
    ): Promise<{ content: string; isError: boolean }> {
      if (!parent.delegatesTo.includes(agentType))
        return { content: `'${parent.agent.id}' may not delegate to '${agentType}'`, isError: true }
      const entry = registry.get(agentType)
      if (!entry) return { content: `unknown subagent: ${agentType}`, isError: true }
      const depth = parentDepth + 1
      if (depth > maxDepth) return { content: `max delegation depth (${maxDepth}) reached`, isError: true }
      const lane: LaneOptions = { prefix: `w:${toolCallId}:`, parent: `${parentLane.prefix}${toolCallId}` }
      const res = await runLane(entry, task, lane, depth)
      if (res.error !== undefined) return { content: res.error, isError: true }
      return { content: res.text.trim() || `(${agentType} produced no report)`, isError: false }
    }

    try {
      const res = await runLane(registry.get(cfg.agent.id)!, input, { prefix: 's:' }, 0)
      bail() // a sink failure swallowed by a tool-error wind-down still fails the turn
      return res
    } finally {
      opts?.abortSignal?.removeEventListener('abort', chain)
    }
  }

  return { run }
}
