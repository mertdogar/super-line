/**
 * The panel's vocabulary: wire frame types in, English out.
 *
 * Every label pairs with the wire token that produced it (rendered as a dim chip), because the two
 * audiences are different and both are real — you read the English, and you screenshot the token into
 * an issue. Hiding the token would make the Frames view pointless; showing only the token is what made
 * the first version unreadable.
 */

import type { ClientTapEvent, Frame } from '@super-line/core'

/** What a row belongs to. One set, used identically in both modes, so switching does not reset the filter. */
export type Category = 'requests' | 'subscriptions' | 'collections' | 'documents' | 'connection' | 'heartbeat'

export const CATEGORIES: Category[] = [
  'requests',
  'subscriptions',
  'collections',
  'documents',
  'connection',
  'heartbeat',
]

/** A row's two names: what it means, and what it literally was on the wire. */
export interface Named {
  /** Human label, e.g. `subscribe messages`. */
  label: string
  /** The wire frame type, e.g. `csub`. Absent for events that never were a frame. */
  wire?: string
  /** Secondary line, e.g. a query, a close code, a row count. */
  detail?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '')

/** Compact one-line rendering of a query IR — enough to tell two subscriptions apart. */
export function summarizeQuery(query: unknown): string | undefined {
  if (!query || typeof query !== 'object') return undefined
  const q = query as { filter?: unknown; orderBy?: unknown; limit?: number }
  const parts: string[] = []
  if (q.filter) parts.push(summarizeExpr(q.filter))
  if (q.limit !== undefined) parts.push(`limit ${q.limit}`)
  return parts.length ? parts.join(' · ') : undefined
}

function summarizeExpr(expr: unknown): string {
  if (!expr || typeof expr !== 'object') return str(expr)
  const e = expr as { op?: string; field?: string; value?: unknown; exprs?: unknown[] }
  if (e.op === 'and' || e.op === 'or') return (e.exprs ?? []).map(summarizeExpr).join(` ${e.op} `)
  if (e.op === 'not') return `not ${summarizeExpr((e.exprs ?? [])[0])}`
  if (e.field) return `${e.field} ${e.op ?? '='} ${str(e.value)}`
  return str(expr)
}

/**
 * Name one wire frame. `answers` is the request a `res`/`err` replies to, when the caller has paired
 * them — which is what turns an unreadable `res #2` into `response · subscribe messages`.
 */
export function frameName(f: Frame, answers?: string): Named {
  switch (f.t) {
    case 'req':
      return { label: f.m, wire: 'req' }
    case 'res':
      return { label: answers ? `response · ${answers}` : 'response', wire: 'res' }
    case 'err':
      return { label: answers ? `failed · ${answers}` : 'error', wire: 'err', detail: `${f.code} — ${f.m}` }
    case 'sub':
      return { label: `subscribe ${f.c}`, wire: 'sub' }
    case 'unsub':
      return { label: `unsubscribe ${f.c}`, wire: 'unsub' }
    case 'evt':
      return { label: `event ${f.e}`, wire: 'evt' }
    case 'pub':
      return { label: `topic ${f.c}`, wire: 'pub' }
    case 'env':
      return { label: 'connection env', wire: 'env' }
    case 'sreq':
      return { label: `server asks ${f.m}`, wire: 'sreq' }
    case 'sres':
      return { label: 'reply to server', wire: 'sres' }
    case 'serr':
      return { label: 'reply to server failed', wire: 'serr', detail: `${f.code} — ${f.m}` }
    // collections — the frame has always carried the collection name; the first version simply dropped it
    case 'csub':
      return { label: `subscribe ${f.n}`, wire: 'csub', detail: summarizeQuery(f.q) }
    case 'cuns':
      return { label: `unsubscribe ${f.n}`, wire: 'cuns' }
    case 'cbat': {
      const ops = f.ops ?? []
      const names = [...new Set(ops.map((o) => o.n))].join(', ')
      return { label: `write ${names || 'collections'}`, wire: 'cbat', detail: `${ops.length} op${ops.length === 1 ? '' : 's'}` }
    }
    case 'cchg':
      return { label: `${f.n} changed`, wire: 'cchg', detail: `${f.k} · ${f.id}` }
    // CRDT documents
    case 'cdopen':
      return { label: `open ${f.n}/${f.id}`, wire: 'cdopen' }
    case 'cdwr':
      return { label: `write ${f.n}/${f.id}`, wire: 'cdwr' }
    case 'cdchg':
      return { label: `${f.n}/${f.id} changed`, wire: 'cdchg' }
    case 'cddel':
      return { label: `${f.n}/${f.id} deleted`, wire: 'cddel' }
    case 'cdclose':
      return { label: `close ${f.n}/${f.id}`, wire: 'cdclose' }
    case 'ping':
      return { label: 'heartbeat', wire: 'ping' }
    case 'pong':
      return { label: 'heartbeat', wire: 'pong' }
  }
}

/** Name any tap event. `answers` applies only to response frames. */
export function eventName(event: ClientTapEvent, answers?: string): Named {
  switch (event.k) {
    case 'frame':
      return frameName(event.f, answers)
    case 'req.queued':
      return { label: event.m, wire: 'queued', detail: 'waiting for a writable socket' }
    case 'req.dropped':
      return {
        label: event.m,
        wire: 'dropped',
        detail: event.why === 'timeout' ? 'timed out' : 'connection closed before it was answered',
      }
    case 'deliver':
      return {
        label: `${event.kind} ${event.name}`,
        wire: 'deliver',
        detail: event.listeners === 0 ? 'no listeners' : `${event.listeners} listener${event.listeners === 1 ? '' : 's'}`,
      }
    case 'validate.fail':
      return { label: `${event.name} failed validation`, wire: 'invalid', detail: event.message }
    case 'route':
      return { label: `${event.n} ${event.decision}`, wire: 'route', detail: `sid ${event.sid} · ${event.id}` }
    case 'conn':
      return {
        label: `connection ${event.phase}`,
        wire: 'conn',
        detail:
          event.phase === 'retry'
            ? `attempt ${event.attempt} in ${event.delayMs}ms`
            : event.code !== undefined
              ? `code ${event.code}`
              : undefined,
      }
    case 'doc':
      return {
        label: `${event.n}/${event.id}`,
        wire: 'doc',
        detail: event.replicas === 0 ? 'no open replica — dropped' : `${event.replicas} replica${event.replicas === 1 ? '' : 's'}`,
      }
  }
}

const FRAME_CATEGORY: Record<Frame['t'], Category> = {
  req: 'requests',
  res: 'requests',
  err: 'requests',
  sreq: 'requests',
  sres: 'requests',
  serr: 'requests',
  sub: 'subscriptions',
  unsub: 'subscriptions',
  evt: 'subscriptions',
  pub: 'subscriptions',
  csub: 'collections',
  cuns: 'collections',
  cbat: 'collections',
  cchg: 'collections',
  cdopen: 'documents',
  cdwr: 'documents',
  cdchg: 'documents',
  cddel: 'documents',
  cdclose: 'documents',
  env: 'connection',
  ping: 'heartbeat',
  pong: 'heartbeat',
}

export function categoryOf(event: ClientTapEvent): Category {
  switch (event.k) {
    case 'frame':
      return FRAME_CATEGORY[event.f.t]
    case 'req.queued':
    case 'req.dropped':
      return 'requests'
    case 'deliver':
      return 'subscriptions'
    case 'route':
      return 'collections'
    case 'doc':
      return 'documents'
    case 'conn':
      return 'connection'
    // a validation failure belongs to whatever it was validating, not to a category of its own
    case 'validate.fail':
      return event.kind === 'response' ? 'requests' : 'subscriptions'
  }
}

/**
 * Whether this event is something going wrong. Deliberately NOT a category: problems cut across every
 * one of them (a failed request, a dropped delivery, a rejected payload), so they filter on their own
 * axis instead of pretending to be a seventh peer.
 */
export function isProblem(event: ClientTapEvent): boolean {
  if (event.k === 'req.dropped' || event.k === 'validate.fail') return true
  if (event.k === 'frame') return event.f.t === 'err' || event.f.t === 'serr'
  if (event.k === 'conn') return event.phase === 'close' || event.phase === 'retry'
  // an event nobody is listening to is a bug with no other symptom
  if (event.k === 'deliver') return event.listeners === 0
  if (event.k === 'doc') return event.replicas === 0
  return false
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
