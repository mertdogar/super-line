/**
 * The panel's entire data layer, as a pure fold over drained batches.
 *
 * Everything subtle lives here on purpose — sequence reconciliation, gap repair, page-load
 * boundaries, request pairing — so that the parts which cannot run outside Chrome (the devtools
 * page, the service worker, the permission button) stay dumb enough not to need tests.
 */

import type { ClientTapEvent, ClientTapRecord } from '@super-line/core'
import type { ClientSummary, DrainBatch } from '@super-line/plugin-devtools'
import { categoryOf, eventName, isProblem, type Category } from './labels.js'

/** The tap version this panel was built against. A page emitting anything else is reported, not guessed at. */
export const SUPPORTED_TAP_VERSION = 1

/** One line in the timeline. */
export interface Row {
  seq: number
  ts: number
  clientId: string
  event: ClientTapEvent
  /**
   * For an outbound request frame: the round-trip in ms, once its response has landed. Computed here
   * rather than at the emit site, because pairing is a reader's job.
   */
  latencyMs?: number
  /** For an outbound request frame still unanswered. */
  pending?: boolean
}

/** A visible break in the timeline. Never inferred silently — both kinds are rendered. */
export interface Divider {
  kind: 'page-load' | 'dropped'
  seq: number
  /** For `dropped`: how many records were evicted before the panel reached them. */
  count?: number
  /** For `page-load`: when the new load began. */
  ts?: number
}

export type Entry = ({ type: 'row' } & Row) | ({ type: 'divider' } & Divider)

/** One in-flight request, for the state rail. */
export interface InFlight {
  clientId: string
  i: number
  method: string
  /** `false` while queued behind an unwritable socket. */
  sent: boolean
  /** When the request went out, so the rail can age it. */
  ts: number
}

/** A client's connection status, folded from `conn` events. */
export interface ClientState extends ClientSummary {
  status: 'connecting' | 'open' | 'closed' | 'retrying'
  /** Last close code seen. */
  code?: number
  /** For `retrying`: which attempt and how long the client will wait. */
  attempt?: number
  delayMs?: number
  /** When this client's first record was seen, so the rail can show uptime. */
  since?: number
}

export interface PanelState {
  /** Ordered timeline, oldest first, including dividers. */
  entries: Entry[]
  /** Highest sequence consumed; passed back to the next drain. */
  cursor: number
  /** The page load the cursor belongs to. A change means the page reloaded and sequences restarted. */
  pageLoadId?: string
  clients: ClientState[]
  inFlight: InFlight[]
  /** Set when the page's tap version is not the one this panel understands. */
  versionWarning?: string
  /** Total records dropped this session, for a status line. */
  droppedTotal: number
}

export const initialState = (): PanelState => ({
  entries: [],
  cursor: 0,
  clients: [],
  inFlight: [],
  droppedTotal: 0,
})

/** How many entries the panel keeps. Beyond this the oldest are discarded — the page buffer is not the only bound. */
export const MAX_ENTRIES = 50_000

const isReqFrame = (e: ClientTapEvent): e is Extract<ClientTapEvent, { k: 'frame' }> =>
  e.k === 'frame' && e.dir === 'out' && e.f.t === 'req'

const frameId = (e: Extract<ClientTapEvent, { k: 'frame' }>): number | undefined =>
  'i' in e.f ? (e.f as { i?: number }).i : undefined

/** A request is keyed by client AND correlation id: two clients on a page both count from 1. */
const key = (clientId: string, i: number): string => `${clientId}#${i}`

function statusFrom(prev: ClientState | undefined, e: Extract<ClientTapEvent, { k: 'conn' }>): Partial<ClientState> {
  if (e.phase === 'open') return { status: 'open', code: undefined, attempt: undefined, delayMs: undefined }
  if (e.phase === 'close') return { status: 'closed', code: e.code }
  return { status: 'retrying', attempt: e.attempt, delayMs: e.delayMs, code: prev?.code }
}

/**
 * Fold one drained batch into the panel state.
 *
 * `preserve` keeps history across a page reload (the Network panel's "Preserve log"). Without it a
 * reload clears, matching the page's own memory; with it the old entries stay behind a divider, which
 * is the only way to debug anything that spans a reload — where boot and auth-restore bugs live.
 */
export function applyBatch(state: PanelState, batch: DrainBatch, preserve = true): PanelState {
  // A page that speaks a different tap version is reported rather than rendered as if understood.
  const versionWarning =
    batch.tapVersion === SUPPORTED_TAP_VERSION
      ? undefined
      : `This page emits tap version ${batch.tapVersion}; this panel understands ${SUPPORTED_TAP_VERSION}. Update whichever is older.`

  const reloaded = state.pageLoadId !== undefined && state.pageLoadId !== batch.pageLoadId
  let entries = reloaded && !preserve ? [] : [...state.entries]
  let inFlight = reloaded ? [] : [...state.inFlight]
  let droppedTotal = state.droppedTotal

  // A reload restarts the page's sequence at zero, so it reads as a gap unless the boundary is
  // explicit. This is why pageLoadId exists at all.
  if (reloaded && entries.length) {
    entries.push({ type: 'divider', kind: 'page-load', seq: 0, ts: batch.records[0]?.ts ?? Date.now() })
  }

  if (batch.dropped > 0) {
    droppedTotal += batch.dropped
    entries.push({ type: 'divider', kind: 'dropped', seq: state.cursor, count: batch.dropped })
  }

  const clients = new Map(state.clients.map((c) => [c.clientId, c]))
  for (const summary of batch.clients) {
    const prev = clients.get(summary.clientId)
    clients.set(summary.clientId, { status: 'connecting', ...prev, ...summary })
  }

  // index of pending request rows, so a response can backfill its latency in place
  const pendingRows = new Map<string, Row & { type: 'row' }>()
  for (const entry of entries) {
    if (entry.type !== 'row' || !entry.pending || !isReqFrame(entry.event)) continue
    const i = frameId(entry.event)
    if (i !== undefined) pendingRows.set(key(entry.clientId, i), entry)
  }

  for (const record of batch.records) {
    // Dedup: with polling and push both live, the same record can arrive twice. Sequence is the only
    // thing that makes that safe, and it is why push is an optimization rather than a second source.
    if (record.seq <= state.cursor && !reloaded) continue

    const row = rowFor(record)
    const client = clients.get(record.clientId)
    if (client && client.since === undefined) clients.set(record.clientId, { ...client, since: record.ts })

    const { event } = record
    if (event.k === 'conn') {
      const prev = clients.get(record.clientId)
      if (prev) clients.set(record.clientId, { ...prev, ...statusFrom(prev, event) })
      // a close abandons everything that client had in flight
      if (event.phase === 'close') inFlight = inFlight.filter((f) => f.clientId !== record.clientId)
    }

    // One `frame` branch, split inside. Splitting it OUTSIDE with a type predicate silently narrows the
    // else-chain to "not a frame event at all", which makes the inbound arm unreachable.
    if (event.k === 'frame') {
      const i = frameId(event)
      if (event.dir === 'out' && event.f.t === 'req' && i !== undefined) {
        row.pending = true
        pendingRows.set(key(record.clientId, i), row as Row & { type: 'row' })
        inFlight.push({
          clientId: record.clientId,
          i,
          method: (event.f as { m: string }).m,
          sent: true,
          ts: record.ts,
        })
      } else if (event.dir === 'in' && (event.f.t === 'res' || event.f.t === 'err') && i !== undefined) {
        // res and err both answer a request; anything else inbound is unsolicited
        const waiting = pendingRows.get(key(record.clientId, i))
        if (waiting) {
          waiting.pending = false
          waiting.latencyMs = record.ts - waiting.ts
          pendingRows.delete(key(record.clientId, i))
        }
        inFlight = inFlight.filter((f) => !(f.clientId === record.clientId && f.i === i))
      }
    } else if (event.k === 'req.queued') {
      inFlight.push({ clientId: record.clientId, i: event.i, method: event.m, sent: false, ts: record.ts })
    } else if (event.k === 'req.dropped') {
      inFlight = inFlight.filter((f) => !(f.clientId === record.clientId && f.i === event.i))
      const waiting = pendingRows.get(key(record.clientId, event.i))
      if (waiting) {
        waiting.pending = false
        pendingRows.delete(key(record.clientId, event.i))
      }
    }

    entries.push(row)
  }

  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES)

  return {
    entries,
    cursor: batch.cursor,
    pageLoadId: batch.pageLoadId,
    clients: [...clients.values()],
    inFlight,
    versionWarning,
    droppedTotal,
  }
}

function rowFor(record: ClientTapRecord): { type: 'row' } & Row {
  return {
    type: 'row',
    seq: record.seq,
    ts: record.ts,
    clientId: record.clientId,
    event: record.event,
  }
}

/** Whether a gap opened between what the panel has and what arrived — a signal to re-drain from `cursor`. */
export const hasGap = (state: PanelState, firstSeq: number): boolean =>
  state.cursor > 0 && firstSeq > state.cursor + 1

/**
 * Fold ONE pushed record, reusing the same path as a drained batch rather than growing a second one.
 *
 * Returns `null` when the record cannot be folded safely — it is a duplicate the poll already covered,
 * it belongs to a different page load, or it sits past a gap. In every one of those cases the answer is
 * the same: leave it to the poll, which is authoritative for repair.
 */
export function applyPushed(state: PanelState, record: ClientTapRecord, preserve = true): PanelState | null {
  if (state.pageLoadId === undefined) return null // nothing drained yet; the poll establishes the load
  if (record.seq <= state.cursor) return null // already folded
  if (hasGap(state, record.seq)) return null // missing records in between — only a drain can fill them
  return applyBatch(
    state,
    {
      tapVersion: SUPPORTED_TAP_VERSION,
      pageLoadId: state.pageLoadId,
      records: [record],
      cursor: record.seq,
      dropped: 0,
      more: false,
      clients: state.clients,
    },
    preserve,
  )
}

// ---- filtering, applied at render time so the underlying log is never mutated ----

export interface Filter {
  /** Only these clients; empty means all. */
  clientIds?: string[]
  /** Only these categories; empty means all. */
  categories?: Category[]
  /** Case-insensitive substring over the row's display name. */
  text?: string
  /**
   * Show only things going wrong. Deliberately its own axis rather than a category, because problems
   * cut across every one of them — a failed request, a dropped delivery, a rejected payload.
   */
  problemsOnly?: boolean
  /** Include ping/pong. Off by default: a 30s heartbeat dominates a quiet session and is never the bug. */
  heartbeat?: boolean
}

/** Whether an event survives the filter. Shared by both modes so the chips mean one thing. */
export function matchesFilter(
  filter: Filter,
  o: { clientId: string; category: Category; problem: boolean; label: string },
): boolean {
  if (!filter.heartbeat && o.category === 'heartbeat') return false
  if (filter.clientIds?.length && !filter.clientIds.includes(o.clientId)) return false
  if (filter.categories?.length && !filter.categories.includes(o.category)) return false
  if (filter.problemsOnly && !o.problem) return false
  const needle = filter.text?.trim().toLowerCase()
  if (needle && !o.label.toLowerCase().includes(needle)) return false
  return true
}

/** Filter the raw frame stream (Frames mode). Dividers always survive — a gap stays visible under
 * every filter, so a filtered view never looks complete when it is not. */
export function applyFilter(entries: Entry[], filter: Filter): Entry[] {
  return entries.filter((entry) => {
    if (entry.type === 'divider') return true
    return matchesFilter(filter, {
      clientId: entry.clientId,
      category: categoryOf(entry.event),
      problem: isProblem(entry.event),
      label: eventName(entry.event).label,
    })
  })
}
