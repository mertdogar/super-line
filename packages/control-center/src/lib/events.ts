import { eventPayload, type ConnDescriptor, type InspectorEnvelope, type InspectorEvent, type MessageFlavor } from '@super-line/core'
import {
  familyColor,
  familyShort,
  transportColor,
  transportFamily,
  transportLabel,
  type TransportFamily,
} from './transport'

export { eventPayload }

/** Resolves a connId / nodeId to friendly labels, so the feed shows names not hashes. */
export interface FeedResolver {
  conn(connId: string): ConnDescriptor | undefined
  nodeName(nodeId: string): string
  /** Wire-family breakdown of the connections currently in `room` (for broadcast attribution). */
  roomWires?(room: string): { family: TransportFamily; count: number }[]
}

/** The wire(s) a feed row is attributable to: one wire (inbound rows) or a fan-out breakdown (broadcasts). */
export type WireAttribution =
  | { kind: 'one'; label: string; color: string; family: TransportFamily }
  | { kind: 'many'; parts: { short: string; count: number; color: string; family: TransportFamily }[] }

function wireOf(transport: string | undefined): WireAttribution {
  return {
    kind: 'one',
    label: transportLabel(transport),
    color: transportColor(transport),
    family: transportFamily(transport),
  }
}

function connWire(connId: string, r?: FeedResolver): WireAttribution | undefined {
  const d = r?.conn(connId)
  return d ? wireOf(d.transport) : undefined // no chip when the conn is unknown/already purged
}

/**
 * The wire a feed row is attributable to, or `undefined` when it isn't. Inbound rows
 * (request/response, lifecycle, directed event) resolve to one wire via their connId; a broadcast
 * resolves to its room members' wires. `msg.publish` (topic subs aren't in the descriptor) and
 * `msg.serverRequest`/`serverReply` (the node↔node adapter axis, not a client wire) are intentionally
 * left unattributed.
 */
export function eventWire(event: InspectorEvent, r?: FeedResolver): WireAttribution | undefined {
  switch (event.type) {
    case 'connect':
      return wireOf(event.descriptor.transport)
    case 'disconnect':
    case 'room.add':
    case 'room.remove':
    case 'topic.sub':
    case 'topic.unsub':
    case 'msg.request':
    case 'msg.response':
      return connWire(event.connId, r)
    case 'msg.event':
      return connWire(event.target, r)
    case 'msg.broadcast': {
      const wires = r?.roomWires?.(event.room) ?? []
      return wires.length
        ? {
            kind: 'many',
            parts: wires.map((w) => ({
              short: familyShort(w.family),
              count: w.count,
              color: familyColor(w.family),
              family: w.family,
            })),
          }
        : undefined
    }
    case 'msg.publish':
    case 'msg.serverRequest':
    case 'msg.serverReply':
      return undefined
    // Collection/CRDT client ops resolve to the originating conn's wire; fan-out (change/delete) is unattributed.
    case 'collection.sub':
    case 'collection.unsub':
    case 'collection.write':
    case 'crdt.open':
    case 'crdt.write':
    case 'crdt.close':
      return connWire(event.connId, r)
    case 'collection.change':
    case 'crdt.change':
    case 'crdt.delete':
      return undefined
  }
}

function nameOf(role: string, id: string, userId?: string): string {
  return userId ? `${userId} (${role})` : `${role} ${id.slice(0, 8)}`
}

function who(connId: string, r?: FeedResolver): string {
  const d = r?.conn(connId)
  return d ? nameOf(d.role, d.id, d.userId) : connId.slice(0, 8)
}

/** A short human summary of a live inspector event, for the feed. Pass a resolver to show names. */
export function summarizeEvent(event: InspectorEvent, r?: FeedResolver): string {
  switch (event.type) {
    case 'connect': {
      const d = event.descriptor
      return `${nameOf(d.role, d.id, d.userId)} on ${d.nodeName}`
    }
    case 'disconnect': {
      const label = event.userId ?? who(event.connId, r)
      return `${label} on ${r?.nodeName(event.nodeId) ?? event.nodeId.slice(0, 8)}`
    }
    case 'room.add':
    case 'room.remove':
      return `${who(event.connId, r)} · ${event.room}`
    case 'topic.sub':
    case 'topic.unsub':
      return `${who(event.connId, r)} · ${event.topic}`
    case 'msg.request':
      return `${who(event.connId, r)} → ${event.name}`
    case 'msg.response':
      return `${who(event.connId, r)} ← ${event.name} · ${event.ok ? 'ok' : event.error?.code ?? 'error'}`
    case 'msg.event':
      return `→ ${who(event.target, r)} · ${event.name}`
    case 'msg.broadcast':
      return `${event.room} ⇒ ${event.name}`
    case 'msg.publish':
      return event.topic
    case 'msg.serverRequest':
      return `→ ${who(event.target, r)} · ${event.name}`
    case 'msg.serverReply':
      return `← ${who(event.target, r)} · ${event.name} · ${event.ok ? 'ok' : event.error?.code ?? 'error'}`
    case 'collection.sub':
      return `${who(event.connId, r)} ⊙ ${event.n}${event.ok ? ` · ${event.count ?? 0} rows` : ` · ✗ ${event.error?.code ?? 'error'}`}`
    case 'collection.unsub':
      return `${who(event.connId, r)} ⊘ ${event.n}`
    case 'collection.write': {
      const count = Array.isArray(event.ops) ? event.ops.length : 0
      return `${who(event.connId, r)} ⊕ ${count} op${count === 1 ? '' : 's'} · ${event.ok ? 'ok' : `✗ ${event.error?.code ?? 'error'}`}`
    }
    case 'collection.change':
      return `${event.n} ⇒ ${event.op} · ${event.id}`
    case 'crdt.open':
      return `${who(event.connId, r)} ⊙ ${event.n}/${event.id}${event.ok ? '' : ` · ✗ ${event.error?.code ?? 'error'}`}`
    case 'crdt.write':
      return `${who(event.connId, r)} → ${event.n}/${event.id} · ${event.ok ? 'ok' : `✗ ${event.error?.code ?? 'error'}`}`
    case 'crdt.close':
      return `${who(event.connId, r)} ⊘ ${event.n}/${event.id}`
    case 'crdt.change':
      return `${event.n}/${event.id} ⇐ ${event.origin}`
    case 'crdt.delete':
      return `${event.n}/${event.id} · deleted`
  }
}

/** Coarse feed category, for the live-feed filter toggles. */
export type FeedCategory = 'lifecycle' | 'requests' | 'events' | 'collections'

export function eventCategory(type: InspectorEvent['type']): FeedCategory {
  if (type.startsWith('collection.') || type.startsWith('crdt.')) return 'collections'
  if (type === 'msg.request' || type === 'msg.response' || type === 'msg.serverRequest' || type === 'msg.serverReply')
    return 'requests'
  if (type.startsWith('msg.')) return 'events'
  return 'lifecycle'
}

/** Tailwind text/bg accent class for an event type (feed dot). */
export function eventColor(type: InspectorEvent['type']): string {
  if (type === 'connect') return 'bg-primary'
  if (type === 'disconnect') return 'bg-destructive'
  if (type.startsWith('room')) return 'bg-violet-400'
  if (type.startsWith('topic')) return 'bg-amber-400'
  if (type.startsWith('collection.')) return 'bg-teal-400'
  if (type.startsWith('crdt.')) return 'bg-fuchsia-400'
  if (type === 'msg.request' || type === 'msg.serverRequest') return 'bg-cyan-400'
  if (type === 'msg.response' || type === 'msg.serverReply') return 'bg-emerald-400'
  if (type === 'msg.event' || type === 'msg.broadcast' || type === 'msg.publish') return 'bg-sky-400'
  return 'bg-amber-400'
}

const FLAVOR_COLORS: Record<MessageFlavor, string> = {
  request: '#22d3ee',
  event: '#34d399',
  topic: '#a78bfa',
  serverRequest: '#60a5fa',
}

export function flavorColor(flavor: MessageFlavor): string {
  return FLAVOR_COLORS[flavor]
}

/** Clock time of an epoch-ms instant, e.g. "9:58:42 PM". */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

/** Compact elapsed time since an epoch-ms instant, e.g. "14m", "2h 3m". */
export function formatDuration(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** A heatmap band: applies to values strictly below `max`; the last band (max=Infinity) catches the rest. */
type HeatBand = { max: number; color: string }

// dark-theme-legible green→red ramp (same family as the event dots)
const LATENCY_BANDS: HeatBand[] = [
  { max: 10, color: '#4ade80' },
  { max: 30, color: '#a3e635' },
  { max: 100, color: '#facc15' },
  { max: 500, color: '#fb923c' },
  { max: Infinity, color: '#f87171' },
]
const SIZE_BANDS: HeatBand[] = [
  { max: 512, color: '#4ade80' },
  { max: 4096, color: '#a3e635' },
  { max: 32_768, color: '#facc15' },
  { max: 262_144, color: '#fb923c' },
  { max: Infinity, color: '#f87171' },
]
function bandColor(bands: HeatBand[], v: number): string {
  return (bands.find((b) => v < b.max) ?? bands[bands.length - 1]!).color
}
/** Heatmap color for a round-trip latency (ms): green (fast) → red (slow). */
export function latencyColor(ms: number): string {
  return bandColor(LATENCY_BANDS, ms)
}
/** Heatmap color for a payload size (bytes): green (small) → red (fat). */
export function sizeColor(bytes: number): string {
  return bandColor(SIZE_BANDS, bytes)
}
/** Bar fill fraction (0..1) of a value against the in-view max; 0 when max is 0/absent. */
export function barFraction(value: number, max: number): number {
  return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
}

/** Human byte size, e.g. "512 B", "1.2 KB". Em-dash for events with no payload. */
export function formatBytes(n?: number): string {
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Correlation key pairing a response/reply with its request, or undefined for unpaired events. */
function pairKey(event: InspectorEvent): string | undefined {
  switch (event.type) {
    case 'msg.request':
    case 'msg.response':
      return `c:${event.connId}:${event.reqId}`
    case 'msg.serverRequest':
    case 'msg.serverReply':
      return `s:${event.target}:${event.reqId}`
    default:
      return undefined
  }
}

/** Emit times of the request/serverRequest envelopes in `envs`, keyed for pairing. */
export function requestTimes(envs: InspectorEnvelope[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const en of envs) {
    if (en.event.type === 'msg.request' || en.event.type === 'msg.serverRequest') {
      const k = pairKey(en.event)
      if (k) m.set(k, en.ts)
    }
  }
  return m
}

/** Round-trip ms for a response/reply envelope, or undefined if its request isn't in `reqTimes`. */
export function latencyOf(en: InspectorEnvelope, reqTimes: Map<string, number>): number | undefined {
  if (en.event.type !== 'msg.response' && en.event.type !== 'msg.serverReply') return undefined
  const k = pairKey(en.event)
  const t0 = k === undefined ? undefined : reqTimes.get(k)
  return t0 === undefined ? undefined : Math.max(0, en.ts - t0)
}

/** The wire families a row is attributable to ([] when none — publish/server-axis). */
export function eventWireFamilies(event: InspectorEvent, r?: FeedResolver): TransportFamily[] {
  const w = eventWire(event, r)
  if (!w) return []
  return w.kind === 'one' ? [w.family] : w.parts.map((p) => p.family)
}

/** Every event type, for the grouped type filter. Grouped by `eventCategory` in the UI. */
export const ALL_EVENT_TYPES: InspectorEvent['type'][] = [
  'connect',
  'disconnect',
  'room.add',
  'room.remove',
  'topic.sub',
  'topic.unsub',
  'msg.request',
  'msg.response',
  'msg.event',
  'msg.broadcast',
  'msg.publish',
  'msg.serverRequest',
  'msg.serverReply',
  'collection.sub',
  'collection.unsub',
  'collection.write',
  'collection.change',
  'crdt.open',
  'crdt.write',
  'crdt.close',
  'crdt.change',
  'crdt.delete',
]

/** The relative trailing-window presets for the time filter (null = All). */
export const TIME_WINDOWS: { label: string; ms: number | null }[] = [
  { label: '15s', ms: 15_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 300_000 },
  { label: 'All', ms: null },
]

export const MAX_LATENCY_MS = 600_000 // 10 minutes
const LOG_MAX = Math.log10(MAX_LATENCY_MS)
/**
 * Map a 0..1 slider position to ms on a log scale (so sub-second gets most of the track).
 * Returns an exact value (no rounding) so the position↔ms round-trip is stable — rounding here
 * would collapse the low end (positions 1–30 all → 1ms → back to position 0).
 */
export function latencySliderToMs(pos: number): number {
  return Math.pow(10, pos * LOG_MAX)
}
/** Inverse of {@link latencySliderToMs}: ms to a 0..1 slider position. */
export function latencyMsToSlider(ms: number): number {
  return ms <= 1 ? 0 : Math.min(1, Math.log10(ms) / LOG_MAX)
}
/**
 * Map a dual-thumb slider's 0..1000 positions to a latency filter range, or null (off) when the
 * thumbs span the full track. The single source of truth for "full span = filter disengaged".
 */
export function sliderToLatencyFilter(aPos: number, bPos: number): [number, number] | null {
  if (aPos <= 0 && bPos >= 1000) return null
  return [latencySliderToMs(aPos / 1000), latencySliderToMs(bPos / 1000)]
}

export const MAX_SIZE_BYTES = 10_485_760 // 10 MiB
const LOG_MAX_SIZE = Math.log10(MAX_SIZE_BYTES)
/** Map a 0..1 slider position to bytes on a log scale (payloads cluster small, span orders of magnitude). */
export function sizeSliderToBytes(pos: number): number {
  return Math.pow(10, pos * LOG_MAX_SIZE)
}
/** Inverse of {@link sizeSliderToBytes}: bytes to a 0..1 slider position. */
export function sizeBytesToSlider(bytes: number): number {
  return bytes <= 1 ? 0 : Math.min(1, Math.log10(bytes) / LOG_MAX_SIZE)
}
/** Dual-thumb 0..1000 positions to a size filter range, or null (off) when the thumbs span the track. */
export function sliderToSizeFilter(aPos: number, bPos: number): [number, number] | null {
  if (aPos <= 0 && bPos >= 1000) return null
  return [sizeSliderToBytes(aPos / 1000), sizeSliderToBytes(bPos / 1000)]
}

/**
 * The live-feed filter state. Each multi-select is "selected, empty = all (off)". The three restrict
 * dimensions (`wires`, `latency`, `size`) drop rows lacking that attribute only when they're engaged.
 */
export interface FeedFilters {
  text: string
  types: Set<string>
  nodes: Set<string>
  wires: Set<TransportFamily>
  windowMs: number | null
  latency: [number, number] | null
  size: [number, number] | null
}

export function emptyFilters(): FeedFilters {
  return { text: '', types: new Set(), nodes: new Set(), wires: new Set(), windowMs: null, latency: null, size: null }
}

/** Whether any filter is engaged (drives the Reset affordance + count badge). */
export function filtersActive(f: FeedFilters): boolean {
  return (
    f.text !== '' ||
    f.types.size > 0 ||
    f.nodes.size > 0 ||
    f.wires.size > 0 ||
    f.windowMs !== null ||
    f.latency !== null ||
    f.size !== null
  )
}

/**
 * The instant the relative time window is measured back from: wall-clock now while live (so "last
 * 15s" means the last 15 real seconds), or the moment of pause while frozen (so a paused window
 * doesn't drain as real time passes).
 */
export function windowAnchor(paused: boolean, frozenAt: number | null, now: number): number {
  return paused && frozenAt !== null ? frozenAt : now
}

/** Per-row data the predicate needs, precomputed once by the caller. */
export interface RowMatch {
  summary: string
  latency?: number
  families: TransportFamily[]
  nowAnchor: number // see windowAnchor — wall-clock now (live) or freeze time (paused)
}

/** True if an envelope passes every engaged filter (AND across dimensions, OR within a multi-select). */
export function matchesFilters(en: InspectorEnvelope, f: FeedFilters, row: RowMatch): boolean {
  if (f.text) {
    const q = f.text.toLowerCase()
    if (!`${en.event.type} ${row.summary}`.toLowerCase().includes(q)) return false
  }
  if (f.types.size > 0 && !f.types.has(en.event.type)) return false
  if (f.nodes.size > 0 && !f.nodes.has(en.originNodeId)) return false
  if (f.wires.size > 0) {
    if (row.families.length === 0) return false // restrict: no-wire rows drop when the filter is engaged
    if (!row.families.some((fam) => f.wires.has(fam))) return false
  }
  if (f.windowMs !== null && en.ts < row.nowAnchor - f.windowMs) return false
  if (f.latency) {
    if (row.latency === undefined) return false // restrict: only latency-bearing rows
    if (row.latency < f.latency[0] || row.latency > f.latency[1]) return false
  }
  if (f.size) {
    if (en.byteSize === undefined) return false // restrict: only rows with a payload
    if (en.byteSize < f.size[0] || en.byteSize > f.size[1]) return false
  }
  return true
}

/** The chip text of a row's wire attribution ("WebSocket", "ws×2 http×1"), or undefined when unattributed. */
export function wireLabel(event: InspectorEvent, r?: FeedResolver): string | undefined {
  const w = eventWire(event, r)
  if (!w) return undefined
  return w.kind === 'one' ? w.label : w.parts.map((p) => `${p.short}×${p.count}`).join(' ')
}

/** One exported feed row: the raw envelope fields plus the derived view columns, so the file is self-contained. */
export interface ExportRecord {
  event: InspectorEvent
  ts: number
  byteSize?: number
  originNodeId: string
  summary: string
  node: string
  latencyMs?: number
  wire?: string
}

export function exportRecord(
  en: InspectorEnvelope,
  summary: string,
  latencyMs: number | undefined,
  r: FeedResolver,
): ExportRecord {
  return { ...en, summary, node: r.nodeName(en.originNodeId), latencyMs, wire: wireLabel(en.event, r) }
}

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/** CSV of the visible columns (RFC-4180 quoting); the payload lands JSON-stringified in the last cell. */
export function exportCsv(records: ExportRecord[]): string {
  const lines = records.map((r) => {
    const payload = eventPayload(r.event)
    return [
      r.event.type,
      r.summary,
      r.node,
      new Date(r.ts).toISOString(),
      r.byteSize?.toString() ?? '',
      r.latencyMs?.toString() ?? '',
      r.wire ?? '',
      payload === undefined ? '' : JSON.stringify(payload),
    ]
      .map(csvCell)
      .join(',')
  })
  return ['type,summary,node,time,size,latency,wire,payload', ...lines].join('\n')
}

/** JSONL: one compact record per line (no wrapper — line formats carry no metadata). */
export function exportJsonl(records: ExportRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n')
}

/** The .json export: records wrapped with provenance — when, which filters produced it, node id→name map. */
export function exportJson(
  records: ExportRecord[],
  meta: { exportedAt: string; filters: FeedFilters; nodes: { nodeId: string; nodeName: string }[] },
): string {
  const f = meta.filters
  return JSON.stringify(
    {
      exportedAt: meta.exportedAt,
      count: records.length,
      filters: {
        text: f.text,
        types: [...f.types],
        nodes: [...f.nodes],
        wires: [...f.wires],
        windowMs: f.windowMs,
        latency: f.latency,
        size: f.size,
      },
      nodes: meta.nodes,
      events: records,
    },
    null,
    2,
  )
}
