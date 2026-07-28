/**
 * Frames in, operations out.
 *
 * The raw stream splits one logical thing across several rows: a request is `queued` then `req` then
 * `res`; a row change is `cchg` then one `route` per subscription; a delivery is `evt` then `deliver`.
 * Reading that is the thing people complained about. This folds each group into a single row.
 *
 * The one thing it deliberately does NOT do is infer causality. A `cchg` that lands between a request
 * and its response is NOT nested under that request: it is an independent server fan-out that every
 * subscribed client receives, and another writer interleaving would look identical. Nesting it would
 * claim a relationship the wire does not carry — the same reason `left-filter` is a distinct routing
 * decision from `delete` rather than being flattened into it.
 */

import type { ClientTapEvent, ClientTapRecord } from '@super-line/core'
import { categoryOf, eventName, isProblem, summarizeQuery, type Category, type Named } from './labels.js'
import { matchesFilter, type Entry, type Filter, type Row } from './reduce.js'

export type OperationStatus = 'pending' | 'ok' | 'error'

/** One logical operation — what an Activity row is. */
export interface Operation {
  /** Sequence of the record that STARTED it; the row is anchored here and updates in place. */
  seq: number
  ts: number
  clientId: string
  category: Category
  /** Coarse shape, used by export and by the icon. */
  op: 'request' | 'server-request' | 'subscribe' | 'unsubscribe' | 'write' | 'change' | 'delivery' | 'connection' | 'document' | 'other'
  label: string
  wire?: string
  detail?: string
  status: OperationStatus
  /** `out` for anything this client initiated, `in` for a server push or a server→client request. */
  dir: 'out' | 'in'
  /** The wire correlation id, when this operation has one — what lets a reader name the reply. */
  corr?: number
  /**
   * Round trip, measured from when the frame actually WENT OUT — not from when the operation was
   * created. A request that waited for a writable socket reports that wait separately as `queuedMs`;
   * adding it here would double-count it and blame the server for the client's own backpressure.
   */
  latencyMs?: number
  /** When the frame left, if that differs from when the row was created. Internal to the fold. */
  sentAt?: number
  /** How long it sat unsent behind an unwritable socket. */
  queuedMs?: number
  reqBytes?: number
  resBytes?: number
  /** Rows in a collection subscription's initial snapshot. */
  rows?: number
  /** Per-subscription routing decisions, listener counts — the detail the wire splits into extra rows. */
  children: string[]
  error?: string
  /** Every record folded in, oldest first — what the detail pane shows and what export can expand. */
  records: ClientTapRecord[]
  /** True for anything worth surfacing under "problems only". */
  problem: boolean
}

/** An operation as it sits in the list. Rows are MUTATED in place as their acks land, so the object in
 * the output array and the object in the pending map must be the same reference — never a spread copy. */
export type OpRow = { type: 'op' } & Operation

export type OpEntry = OpRow | Extract<Entry, { type: 'divider' }>

const isRow = (e: Entry): e is { type: 'row' } & Row => e.type === 'row'
const recordOf = (row: { type: 'row' } & Row): ClientTapRecord => ({
  event: row.event,
  seq: row.seq,
  ts: row.ts,
  clientId: row.clientId,
})

/** Correlation ids restart per client, so a key must carry both. */
const key = (clientId: string, i: number): string => `${clientId}#${i}`

const frameId = (event: ClientTapEvent): number | undefined =>
  event.k === 'frame' && 'i' in event.f ? (event.f as { i?: number }).i : undefined

function start(row: { type: 'row' } & Row, named: Named, op: Operation['op'], dir: 'out' | 'in'): OpRow {
  return {
    type: 'op',
    seq: row.seq,
    ts: row.ts,
    clientId: row.clientId,
    category: categoryOf(row.event),
    op,
    label: named.label,
    wire: named.wire,
    detail: named.detail,
    status: 'pending',
    dir,
    children: [],
    records: [recordOf(row)],
    problem: isProblem(row.event),
  }
}

/** Coarse shape of an outbound frame, for the icon and the export's `op` column. */
function shapeOf(t: string): Operation['op'] {
  if (t === 'req') return 'request'
  if (t === 'sub' || t === 'csub' || t === 'cdopen') return 'subscribe'
  if (t === 'unsub' || t === 'cuns' || t === 'cdclose') return 'unsubscribe'
  if (t === 'cbat' || t === 'cdwr') return 'write'
  return 'other'
}

/**
 * Fold entries into operations. Dividers pass through untouched, so a page-load boundary or a dropped
 * -records gap stays visible in both modes.
 */
export function toOperations(entries: Entry[]): OpEntry[] {
  const out: OpEntry[] = []
  /** Operations awaiting an ack, by correlation key. */
  const open = new Map<string, OpRow>()
  /** Requests seen as `queued` but not yet sent, so the send can adopt them rather than start a second row. */
  const queued = new Map<string, OpRow>()
  /** The most recent change/delivery per (client, subject), so its trailing detail records can fold in. */
  const foldable = new Map<string, OpRow>()

  const settle = (op: OpRow, row: { type: 'row' } & Row, status: OperationStatus): void => {
    op.status = status
    // from the SEND, not from the row's anchor — see `latencyMs`
    op.latencyMs = row.ts - (op.sentAt ?? op.ts)
    op.records.push(recordOf(row))
    if (status === 'error') op.problem = true
  }

  for (const entry of entries) {
    if (!isRow(entry)) {
      out.push(entry)
      continue
    }
    const { event } = entry
    const named = eventName(event)

    // ---- things that fold INTO an operation already emitted ----

    // one `route` per live subscription follows its `cchg`, emitted synchronously in the same tick
    if (event.k === 'route') {
      const host = foldable.get(`${entry.clientId}:chg:${event.n}:${event.id}`)
      if (host) {
        host.children.push(`sid ${event.sid} · ${event.decision}`)
        host.records.push(recordOf(entry))
        if (isProblem(event)) host.problem = true
        continue
      }
    }
    // a `deliver` follows the evt/pub frame it describes
    if (event.k === 'deliver') {
      const host = foldable.get(`${entry.clientId}:deliver:${event.name}`)
      if (host) {
        host.detail = named.detail
        host.records.push(recordOf(entry))
        host.status = 'ok'
        if (isProblem(event)) host.problem = true
        continue
      }
    }
    // a `doc` record follows the cdchg frame it describes
    if (event.k === 'doc') {
      const host = foldable.get(`${entry.clientId}:doc:${event.n}:${event.id}`)
      if (host) {
        host.detail = named.detail
        host.records.push(recordOf(entry))
        if (isProblem(event)) host.problem = true
        continue
      }
    }

    // ---- things that SETTLE an operation ----

    if (event.k === 'frame' && event.dir === 'in' && (event.f.t === 'res' || event.f.t === 'err')) {
      const i = frameId(event)
      const op = i === undefined ? undefined : open.get(key(entry.clientId, i))
      if (op) {
        open.delete(key(entry.clientId, i!))
        settle(op, entry, event.f.t === 'err' ? 'error' : 'ok')
        op.resBytes = event.bytes
        if (event.f.t === 'err') {
          const f = event.f as { code: string; m: string }
          op.error = `${f.code} — ${f.m}`
          op.detail = op.error
        } else if (Array.isArray((event.f as { d?: unknown }).d) && op.op === 'subscribe') {
          // a collection subscribe is acked with its initial snapshot
          op.rows = ((event.f as { d: unknown[] }).d).length
        }
        continue
      }
    }
    if (event.k === 'req.dropped') {
      const op = open.get(key(entry.clientId, event.i)) ?? queued.get(key(entry.clientId, event.i))
      if (op) {
        open.delete(key(entry.clientId, event.i))
        queued.delete(key(entry.clientId, event.i))
        settle(op, entry, 'error')
        op.latencyMs = undefined // it was never answered, so it has no round trip
        op.error = named.detail
        op.detail = named.detail
        continue
      }
    }
    // the client's reply completes a server→client request
    if (event.k === 'frame' && event.dir === 'out' && (event.f.t === 'sres' || event.f.t === 'serr')) {
      const i = frameId(event)
      const op = i === undefined ? undefined : open.get(key(entry.clientId, i))
      if (op) {
        open.delete(key(entry.clientId, i!))
        settle(op, entry, event.f.t === 'serr' ? 'error' : 'ok')
        op.resBytes = event.bytes
        continue
      }
    }

    // ---- things that START an operation ----

    if (event.k === 'req.queued') {
      const op = start(entry, named, 'request', 'out')
      queued.set(key(entry.clientId, event.i), op)
      out.push(op)
      continue
    }

    if (event.k === 'frame') {
      const f = event.f
      const i = frameId(event)

      if (event.dir === 'out' && i !== undefined && f.t !== 'sres' && f.t !== 'serr') {
        // adopt the queued row rather than starting a second one for the same request
        const adopted = queued.get(key(entry.clientId, i))
        if (adopted) {
          queued.delete(key(entry.clientId, i))
          adopted.queuedMs = entry.ts - adopted.ts
          adopted.sentAt = entry.ts
          adopted.corr = i
          adopted.reqBytes = event.bytes
          adopted.records.push(recordOf(entry))
          adopted.detail = undefined // it is no longer waiting; the queued time is shown instead
          open.set(key(entry.clientId, i), adopted)
          continue
        }
        const op = start(entry, named, shapeOf(f.t), 'out')
        op.corr = i
        op.reqBytes = event.bytes
        if (f.t === 'csub') op.detail = summarizeQuery((f as { q?: unknown }).q)
        open.set(key(entry.clientId, i), op)
        out.push(op)
        continue
      }

      if (event.dir === 'in' && f.t === 'sreq' && i !== undefined) {
        const op = start(entry, named, 'server-request', 'in')
        op.corr = i
        op.reqBytes = event.bytes
        open.set(key(entry.clientId, i), op)
        out.push(op)
        continue
      }

      // inbound pushes and fire-and-forget outbound frames: complete the moment they appear
      const op = start(entry, named, pushShape(f.t), event.dir)
      op.status = 'ok'
      if (event.dir === 'out') op.reqBytes = event.bytes
      else op.resBytes = event.bytes
      out.push(op)

      // remember it briefly so its trailing detail records can fold in
      if (f.t === 'cchg') foldable.set(`${entry.clientId}:chg:${f.n}:${f.id}`, op)
      else if (f.t === 'evt') foldable.set(`${entry.clientId}:deliver:${f.e}`, op)
      else if (f.t === 'pub') foldable.set(`${entry.clientId}:deliver:${f.c}`, op)
      else if (f.t === 'cdchg') foldable.set(`${entry.clientId}:doc:${f.n}:${f.id}`, op)
      continue
    }

    // ---- everything else is its own row ----
    const op = start(entry, named, event.k === 'conn' ? 'connection' : 'other', 'in')
    op.status = isProblem(event) ? 'error' : 'ok'
    out.push(op)
  }

  // `out` holds the objects themselves, so later mutation (a response landing) is already reflected.
  return out
}

/**
 * Filter operations. This runs AFTER the fold, never before: folding a filtered stream would strand
 * every request whose response the filter removed, leaving rows pending forever.
 */
export function applyOpFilter(entries: OpEntry[], filter: Filter): OpEntry[] {
  return entries.filter((entry) => {
    if (entry.type !== 'op') return true // gaps and page-load boundaries survive every filter
    return matchesFilter(filter, entry)
  })
}

function pushShape(t: string): Operation['op'] {
  if (t === 'cchg') return 'change'
  if (t === 'evt' || t === 'pub') return 'delivery'
  if (t === 'cdchg' || t === 'cddel') return 'document'
  if (t === 'ping' || t === 'pong') return 'connection'
  if (t === 'env') return 'connection'
  return 'other'
}
