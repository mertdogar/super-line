// The feed differ: one per open channel. plugin-chat's `messages(channelId)` store serves an
// ASSEMBLED feed (FeedMessage[] — plain rows + live-spliced streamed parts). This diffs successive
// snapshots into the curated event stream (headless-emit.ts):
//
//  • a plain message appearing        → `message`
//  • a bot (status-bearing) message   → `turn_start` … part/delta events … `message` + `turn_done`
//  • a resource card (metadata.resource) → `resource`
//
// Turn markers are derived from FeedMessage.status transitions (streaming → complete/aborted/error).
// The delta stream is re-derived by suffix-diffing each part's text — the feed already coalesced the
// wire deltas onto `part.text` at each checkpoint, so a per-snapshot suffix IS the coalesced delta.

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
  private visible(m: FeedMessage, isBot: boolean): string {
    if (!isBot) return contentText(m)
    const rootText = (m.parts ?? [])
      .filter((p) => p.type === 'text' && p.parent === null)
      .map((p) => p.text)
      .join('')
    return rootText !== '' ? rootText : contentText(m)
  }

  private messageEvent(m: FeedMessage, isBot: boolean): HeadlessEvent {
    return {
      type: 'message',
      channel: this.channel,
      id: m.id,
      authorId: m.authorId,
      author: this.display(m.authorId),
      role: isBot ? 'assistant' : 'user',
      content: this.visible(m, isBot),
      ...(m.status !== undefined ? { status: m.status } : {}),
      createdAt: m.createdAt,
    }
  }

  /** Record the current backlog as already-seen WITHOUT emitting — history is context, not events. */
  prime(rows: FeedMessage[]): void {
    for (const m of rows) {
      this.messages.set(m.id, { isBot: m.status !== undefined, settled: true })
      for (const p of m.parts ?? []) {
        this.partLen.set(p.id, p.text.length)
        this.partSig.set(p.id, this.sig(p))
      }
    }
  }

  private sig(p: MessagePart): string {
    return `${p.state ?? ''}|${p.done}|${p.isError ?? ''}|${p.result !== undefined}`
  }

  private diffParts(m: FeedMessage): HeadlessEvent[] {
    const out: HeadlessEvent[] = []
    for (const p of m.parts ?? []) {
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
        out.push({
          type: 'part',
          channel: this.channel,
          messageId: m.id,
          partId: p.id,
          partIdx: p.idx,
          partType: p.type,
          ...(p.toolName !== undefined ? { toolName: p.toolName } : {}),
          parent: p.parent,
          ...(p.state !== undefined ? { state: p.state } : {}),
          ...(p.isError !== undefined ? { isError: p.isError } : {}),
          done: p.done,
          ...(p.args !== undefined ? { args: p.args } : {}),
          ...(p.result !== undefined ? { result: p.result } : {}),
        })
      }
    }
    return out
  }

  /** Diff a fresh snapshot into curated events. */
  sync(rows: FeedMessage[]): HeadlessEvent[] {
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
          out.push(this.messageEvent(m, false))
          continue
        }
        out.push({ type: 'status', kind: 'turn_start', channel: this.channel, msg: m.id })
      }

      if (isBot && !st.settled) {
        out.push(...this.diffParts(m))
        if (m.status !== undefined && m.status !== 'streaming') {
          st.settled = true
          out.push(this.messageEvent(m, true))
          if (m.status === 'error') {
            out.push({ type: 'error', message: m.error ?? 'failed', channel: this.channel, messageId: m.id })
          }
          out.push({ type: 'status', kind: 'turn_done', channel: this.channel, msg: m.id, status: m.status })
        }
      }
    }
    return out
  }
}
