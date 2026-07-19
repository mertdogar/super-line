// The feed differ combines message envelopes with the host-mounted part stores and turns successive
// snapshots into the curated event stream (headless-emit.ts):
//
//  • a plain message appearing        → `message`
//  • a bot (status-bearing) message   → `turn_start` … part/delta events … `message` + `turn_done`
//  • a resource card (metadata.resource) → `resource`
//
// Turn markers are derived from FeedMessage.status transitions (streaming → complete/aborted/error).
// The delta stream is re-derived by suffix-diffing each part's text.

import type { HeadlessEvent } from './headless-emit'
import type { FeedMessage, MessagePart } from '../contract'

interface ResourceCard {
  action: string
  kind: string
  docId: string
  title: string
}

function resourceOf(m: FeedMessage): ResourceCard | undefined {
  return (m.metadata as { resource?: ResourceCard } | undefined)?.resource
}

function contentText(m: FeedMessage): string {
  const c = m.content
  return typeof c === 'string' ? c : c === undefined ? '' : JSON.stringify(c)
}

interface MsgState {
  isBot: boolean
  settled: boolean
}

export class FeedDiffer {
  private readonly channel: string
  private readonly me: string
  private readonly names: () => Map<string, string>
  private readonly messages = new Map<string, MsgState>()
  private readonly partLen = new Map<string, number>() // partId → last-emitted text length
  private readonly partSig = new Map<string, string>() // partId → last-emitted state signature

  constructor(opts: { channel: string; me: string; names: () => Map<string, string> }) {
    this.channel = opts.channel
    this.me = opts.me
    this.names = opts.names
  }

  private display(id: string): string {
    return this.names().get(id) ?? (id === this.me ? 'you' : `user:${id.slice(0, 8)}`)
  }

  // A streamed turn's visible answer lives in its ROOT text parts — the server's `content` projection
  // can settle empty (the example sets no `project`), so parts are authoritative, content the fallback.
  private visible(m: FeedMessage, isBot: boolean, parts: MessagePart[]): string {
    if (!isBot) return contentText(m)
    const rootText = parts.flatMap((part) => (part.type === 'text' && part.parent === null ? [part.text] : [])).join('')
    return rootText !== '' ? rootText : contentText(m)
  }

  private messageEvent(m: FeedMessage, isBot: boolean, parts: MessagePart[]): HeadlessEvent {
    return {
      type: 'message',
      channel: this.channel,
      id: m.id,
      authorId: m.authorId,
      author: this.display(m.authorId),
      role: isBot ? 'assistant' : 'user',
      content: this.visible(m, isBot, parts),
      ...(m.status !== undefined ? { status: m.status } : {}),
      createdAt: m.createdAt,
    }
  }

  /** Record the current backlog as already-seen WITHOUT emitting — history is context, not events. */
  prime(rows: FeedMessage[], partsByMessage: ReadonlyMap<string, MessagePart[]> = new Map()): void {
    for (const m of rows) {
      this.messages.set(m.id, { isBot: m.status !== undefined, settled: true })
      for (const p of partsByMessage.get(m.id) ?? []) {
        if ('text' in p) this.partLen.set(p.id, p.text.length)
        this.partSig.set(p.id, this.sig(p))
      }
    }
  }

  private sig(p: MessagePart): string {
    return p.type === 'tool'
      ? `${p.state}|${p.done}|${p.isError ?? ''}|${p.result !== undefined}`
      : `${p.type}|${p.done}`
  }

  private diffParts(m: FeedMessage, parts: MessagePart[]): HeadlessEvent[] {
    const out: HeadlessEvent[] = []
    for (const p of parts) {
      // progressive text: the growth suffix since we last saw this part (text + reasoning accumulate)
      if (p.type === 'text' || p.type === 'reasoning') {
        const prev = this.partLen.get(p.id) ?? 0
        if (p.text.length > prev) {
          out.push({
            type: 'delta',
            channel: this.channel,
            messageId: m.id,
            partId: p.id,
            partIdx: p.idx,
            partType: p.type,
            text: p.text.slice(prev),
          })
        }
        this.partLen.set(p.id, p.text.length)
      }
      // structural transition: appear / state change / result arrival / done
      const sig = this.sig(p)
      if (this.partSig.get(p.id) !== sig) {
        this.partSig.set(p.id, sig)
        const tool = p.type === 'tool' ? p : undefined
        out.push({
          type: 'part',
          channel: this.channel,
          messageId: m.id,
          partId: p.id,
          partIdx: p.idx,
          partType: p.type,
          ...(tool?.toolName !== undefined ? { toolName: tool.toolName } : {}),
          parent: p.parent,
          ...(tool ? { state: tool.state } : {}),
          ...(tool?.isError !== undefined ? { isError: tool.isError } : {}),
          done: p.done,
          ...(tool?.args !== undefined ? { args: tool.args } : {}),
          ...(tool?.result !== undefined ? { result: tool.result } : {}),
        })
      }
    }
    return out
  }

  /** Diff a fresh snapshot into curated events. */
  sync(rows: FeedMessage[], partsByMessage: ReadonlyMap<string, MessagePart[]> = new Map()): HeadlessEvent[] {
    const out: HeadlessEvent[] = []
    for (const m of rows) {
      const isBot = m.status !== undefined
      const card = resourceOf(m)
      let st = this.messages.get(m.id)

      if (!st) {
        st = { isBot, settled: false }
        this.messages.set(m.id, st)
        if (card) {
          st.settled = true
          out.push({
            type: 'resource',
            channel: this.channel,
            action: card.action,
            kind: card.kind,
            docId: card.docId,
            title: card.title,
            by: this.display(m.authorId),
          })
          continue
        }
        if (!isBot) {
          st.settled = true
          out.push(this.messageEvent(m, false, []))
          continue
        }
        out.push({ type: 'status', kind: 'turn_start', channel: this.channel, msg: m.id })
      }

      if (isBot && !st.settled) {
        const parts = partsByMessage.get(m.id) ?? []
        out.push(...this.diffParts(m, parts))
        // Gating "turn finished" on a terminal status is SOUND since 0.6.0 (ADR-0014): a streamed
        // message always settles before it vanishes — even a mid-stream delete lands `aborted`
        // here first, so this fold can never wedge on a row that silently disappeared.
        if (m.status !== undefined && m.status !== 'streaming') {
          st.settled = true
          out.push(this.messageEvent(m, true, parts))
          if (m.status === 'error') {
            out.push({ type: 'error', message: m.error ?? 'failed', channel: this.channel, messageId: m.id })
          }
          // per-lane usage data parts (0.6.0 mapDataPart on finish chunks) sum to the turn total
          const tokens = parts.reduce(
            (sum, p) => (p.type === 'data' && p.data.kind === 'usage' ? sum + p.data.totalTokens : sum),
            0,
          )
          out.push({
            type: 'status',
            kind: 'turn_done',
            channel: this.channel,
            msg: m.id,
            status: m.status,
            ...(tokens > 0 ? { tokens } : {}),
          })
        }
      }
    }
    return out
  }
}
