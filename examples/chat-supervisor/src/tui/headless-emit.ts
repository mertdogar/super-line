// The headless output layer (ticket 04/08). ONE curated event stream, rendered two ways:
//
//  • human  — lifecycle `<<MARKER>>` lines + plain `#channel author: text` message lines + `⧉`
//             resource lines. All structure (parts, deltas, presence) is deliberately dropped.
//  • --json — pure JSONL: every line is one curated event object, no ASCII markers, so a single
//             `jq` parses the whole stream.
//
// The feed differ (headless-feed.ts) produces these events; runHeadless also emits lifecycle and
// command-response events through here. Oversized message text spills to disk in HUMAN mode only
// (pure-JSONL inlines everything) — a pointer replaces the tail so the stream stays line-oriented.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The stable, documented event vocabulary (decision 4). Wire internals never leak past this. */
export type HeadlessEvent =
  | { type: 'status'; kind: 'ready'; user: string; channel: string }
  | { type: 'status'; kind: 'turn_start'; channel: string; msg: string }
  | { type: 'status'; kind: 'turn_done'; channel: string; msg: string; status: string }
  | { type: 'status'; kind: 'disconnected' }
  | { type: 'status'; kind: 'reconnected' }
  | { type: 'status'; kind: 'resume'; command: string }
  | {
      type: 'message'
      channel: string
      id: string
      authorId: string
      author: string
      role: 'user' | 'assistant'
      content: string
      status?: string
      createdAt: number
    }
  | { type: 'delta'; channel: string; messageId: string; partId: string; partIdx: number; partType: string; text: string }
  | {
      type: 'part'
      channel: string
      messageId: string
      partId: string
      partIdx: number
      partType: string
      toolName?: string
      parent?: string | null
      state?: string
      isError?: boolean
      done: boolean
      args?: unknown
      result?: unknown
    }
  | { type: 'resource'; channel: string; action: string; kind: string; docId: string; title: string; by: string }
  | { type: 'error'; message: string; channel?: string; messageId?: string; code?: string }
  /** REPL command responses (/channels /who /session /help). A small extension beyond the 7 streaming types — the streaming protocol never emits it. */
  | { type: 'info'; kind: string; text: string; data?: unknown }

export interface Emitter {
  emit(ev: HeadlessEvent): void
  emitAll(evs: HeadlessEvent[]): void
}

const INLINE_LIMIT = 1600

export function makeEmitter(opts: { json: boolean; me: string; spillDir: string }): Emitter {
  const { json, me, spillDir } = opts
  let spillSeq = 0
  let spillReady = false

  const write = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  const spill = (text: string, hint: string): string => {
    if (!spillReady) {
      if (!existsSync(spillDir)) mkdirSync(spillDir, { recursive: true })
      spillReady = true
    }
    const safe = hint.replace(/[^a-z0-9]+/gi, '-').slice(0, 24) || 'text'
    const path = join(spillDir, `${String(spillSeq++).padStart(4, '0')}-${safe}.txt`)
    writeFileSync(path, text)
    return path
  }

  const human = (ev: HeadlessEvent): void => {
    switch (ev.type) {
      case 'status':
        if (ev.kind === 'ready') return write(`<<READY user=${ev.user} channel=${ev.channel}>>`)
        if (ev.kind === 'turn_start') return write(`<<TURN_START channel=${ev.channel} msg=${ev.msg}>>`)
        if (ev.kind === 'turn_done') return write(`<<TURN_DONE channel=${ev.channel} msg=${ev.msg}>>`)
        if (ev.kind === 'disconnected') return write('<<DISCONNECTED>>')
        if (ev.kind === 'reconnected') return write('<<RECONNECTED>>')
        return write(`<<RESUME ${ev.command}>>`)
      case 'message': {
        if (ev.content === '') return // an empty-content turn already showed its TURN markers
        const who = ev.authorId === me ? 'you' : ev.author
        let content = ev.content
        if (content.length > INLINE_LIMIT) {
          const path = spill(content, who)
          content = `${content.slice(0, INLINE_LIMIT)}…[+${content.length - INLINE_LIMIT} chars -> ${path}]`
        }
        return write(`#${ev.channel} ${who}: ${content}`)
      }
      case 'resource':
        return write(`⧉ ${ev.kind} “${ev.title}” ${ev.action} by ${ev.by}`)
      case 'error':
        return write(`<<ERROR ${ev.message}>>`)
      case 'info':
        return write(ev.text)
      // deltas + parts are structure — suppressed in human mode by design (decision 1)
      case 'delta':
      case 'part':
        return
    }
  }

  const emit = (ev: HeadlessEvent): void => {
    if (json) write(JSON.stringify(ev))
    else human(ev)
  }
  return { emit, emitAll: (evs) => evs.forEach(emit) }
}
