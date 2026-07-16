// Maps a Mastra `fullStream` chunk to plugin-chat STREAM EVENTS for ONE lane. A direct port of
// super-harness's chunk-adapter (packages/core/src/harness/chunk-adapter.ts): the same structural
// `ChunkLike` view, the same stateful per-lane mapper with a `suppressToolNames` mechanic, the same
// case vocabulary — only the OUTPUT vocabulary changed, from HarnessEvents to ChatStreamEvents
// (PLAN-chat-streaming decision 4). The same mapper runs at every depth, so a subagent's tool calls
// and text stream with full fidelity, exactly like the supervisor's.
//
// Two deliberate translations from the harness original:
// - harness accumulated ONE text/reasoning blob per node (interleaving in the UI via textOffset);
//   parts have no offsets, so this adapter SEGMENTS instead — a tool call closes the open
//   text/reasoning part and the next delta opens a fresh one. Same rendered order, simpler model.
// - `tool-call-delta` (streaming args text) maps to nothing: plugin-chat v1 lands tool args whole
//   via part_patch. The case stays so the vocabulary keeps parity with the harness mapper.

import type { ChatStreamEvent } from '@super-line/plugin-chat'

// Structural view of a fullStream chunk — the real Mastra ChunkType is assignable to this.
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

export interface ChunkAdapter {
  map(chunk: ChunkLike): ChatStreamEvent[]
  /** Close any still-open text/reasoning segment (call once when the lane's stream ends). */
  end(): ChatStreamEvent[]
  /** Set when the stream emitted a turn-level `error` chunk. */
  error: string | undefined
}

export function createChunkAdapter(suppressToolNames: ReadonlySet<string>, lane: LaneOptions): ChunkAdapter {
  const suppressed = new Set<string>()
  const startedTools = new Set<string>()
  const key = (id: string): string => `${lane.prefix}${id}`
  const parent = lane.parent !== undefined ? { parent: lane.parent } : {}

  // Segmented text/reasoning: one open part per kind at a time; a tool call closes both.
  let seq = 0
  let openText: string | undefined
  let openReasoning: string | undefined
  const closeSegments = (): ChatStreamEvent[] => {
    const out: ChatStreamEvent[] = []
    if (openText !== undefined) out.push({ type: 'part_end', key: openText })
    if (openReasoning !== undefined) out.push({ type: 'part_end', key: openReasoning })
    openText = openReasoning = undefined
    return out
  }

  const self: ChunkAdapter = { map, end: closeSegments, error: undefined }

  function map(chunk: ChunkLike): ChatStreamEvent[] {
    const p = (chunk.payload ?? {}) as Record<string, any>
    switch (chunk.type) {
      case 'text-delta': {
        if (!p.text) return []
        const out: ChatStreamEvent[] = []
        if (openText === undefined) {
          openText = key(`t${seq++}`)
          out.push({ type: 'part_start', key: openText, partType: 'text', ...parent })
        }
        out.push({ type: 'delta', key: openText, text: p.text })
        return out
      }
      case 'reasoning-delta': {
        if (!p.text) return []
        const out: ChatStreamEvent[] = []
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
        const start: ChatStreamEvent[] = startedTools.has(p.toolCallId)
          ? []
          : [
              ...closeSegments(),
              { type: 'part_start', key: key(p.toolCallId), partType: 'tool', toolName: p.toolName, ...parent },
            ]
        startedTools.add(p.toolCallId)
        return [...start, { type: 'part_patch', key: key(p.toolCallId), args: p.args }]
      }
      case 'tool-result':
        if (suppressed.has(p.toolCallId)) return []
        return [
          { type: 'part_patch', key: key(p.toolCallId), result: p.result, isError: !!p.isError },
          { type: 'part_end', key: key(p.toolCallId) },
        ]
      case 'tool-error':
        // A tool whose execute() threw — without this the call stays "running" in the card forever.
        if (suppressed.has(p.toolCallId)) return []
        return [
          { type: 'part_patch', key: key(p.toolCallId), result: { error: errorMessage(p) }, isError: true },
          { type: 'part_end', key: key(p.toolCallId) },
        ]
      case 'error':
        self.error = errorMessage(p)
        return []
      default:
        return [] // step-finish/finish (usage bookkeeping lives in the harness tree, not chat parts), framing
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
