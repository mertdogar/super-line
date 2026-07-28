/**
 * Export what you are looking at.
 *
 * Filters always apply, and the shape follows the current mode: Activity writes merged operations
 * (which is what makes a CSV worth opening — there is a latency column), Frames writes raw records.
 * Mirrors the Control Center's format picker and download helper rather than importing them, since
 * those are typed to the server's `InspectorEnvelope`.
 */

import type { ClientTapRecord } from '@super-line/core'
import { formatClock } from './labels.js'
import type { OpEntry } from './operations.js'
import type { Entry, Filter } from './reduce.js'

export const EXPORT_FORMATS = ['json', 'jsonl', 'csv'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export type ExportMode = 'activity' | 'frames'

export interface ExportContext {
  mode: ExportMode
  pageLoadId?: string
  tapVersion?: number
  filter: Filter
  /** Injected rather than read from the clock, so the output is reproducible under test. */
  now: number
}

/** One row of the Activity export — the flat projection a spreadsheet or a script wants. */
interface ActivityRecord {
  time: string
  ts: number
  client: string
  category: string
  op: string
  name: string
  status: string
  ok: boolean | ''
  latencyMs: number | ''
  queuedMs: number | ''
  reqBytes: number | ''
  resBytes: number | ''
  rows: number | ''
  detail: string
  children: string
  error: string
}

const flattenOps = (entries: OpEntry[]): ActivityRecord[] =>
  entries
    .filter((e): e is Extract<OpEntry, { type: 'op' }> => e.type === 'op')
    .map((o) => ({
      time: formatClock(o.ts),
      ts: o.ts,
      client: o.clientId,
      category: o.category,
      op: o.op,
      name: o.label,
      status: o.status,
      // a pending operation has no verdict yet, and writing `false` would assert one
      ok: o.status === 'pending' ? '' : o.status === 'ok',
      latencyMs: o.latencyMs ?? '',
      queuedMs: o.queuedMs ?? '',
      reqBytes: o.reqBytes ?? '',
      resBytes: o.resBytes ?? '',
      rows: o.rows ?? '',
      detail: o.detail ?? '',
      children: o.children.join(' | '),
      error: o.error ?? '',
    }))

const flattenRecords = (entries: Entry[]): ClientTapRecord[] =>
  entries
    .filter((e): e is Extract<Entry, { type: 'row' }> => e.type === 'row')
    .map((r) => ({ event: r.event, seq: r.seq, ts: r.ts, clientId: r.clientId }))

/** The rows an export will contain, in the shape the mode implies. */
export function exportRows(entries: Entry[], ops: OpEntry[], mode: ExportMode): unknown[] {
  return mode === 'activity' ? flattenOps(ops) : flattenRecords(entries)
}

/**
 * JSON carries an envelope so a file shared into an issue explains itself — which page load it came
 * from, what the tap version was, and crucially WHICH FILTER was active, so nobody mistakes a filtered
 * export for a complete one.
 */
export function exportJson(rows: unknown[], ctx: ExportContext): string {
  return JSON.stringify(
    {
      source: 'super-line devtools',
      exportedAt: new Date(ctx.now).toISOString(),
      mode: ctx.mode,
      pageLoadId: ctx.pageLoadId,
      tapVersion: ctx.tapVersion,
      filter: ctx.filter,
      count: rows.length,
      rows,
    },
    null,
    2,
  )
}

/** One object per line — flat on purpose, for grep and for streaming tools. */
export function exportJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  // quote when the value could otherwise break the row apart
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

/**
 * CSV over the flat projection. In Frames mode the event is one JSON column, because a raw frame has
 * no fixed column set — which is exactly why Activity is the mode worth exporting to a spreadsheet.
 */
export function exportCsv(rows: unknown[]): string {
  if (!rows.length) return ''
  const flat = rows.map((r) => {
    const o = r as Record<string, unknown>
    return 'event' in o ? { seq: o.seq, ts: o.ts, time: formatClock(o.ts as number), client: o.clientId, event: o.event } : o
  })
  const headers = [...new Set(flat.flatMap((r) => Object.keys(r)))]
  const lines = [headers.join(',')]
  for (const row of flat) lines.push(headers.map((h) => csvCell((row as Record<string, unknown>)[h])).join(','))
  return lines.join('\n')
}

export function serialize(rows: unknown[], format: ExportFormat, ctx: ExportContext): string {
  if (format === 'json') return exportJson(rows, ctx)
  if (format === 'jsonl') return exportJsonl(rows)
  return exportCsv(rows)
}

const MIME: Record<ExportFormat, string> = {
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  csv: 'text/csv',
}

/** File-name stamp: sortable, filesystem-safe, no separators a shell would fight. */
export function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

/** The only non-pure part — a link click, same as the Control Center's. */
export function download(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadExport(rows: unknown[], format: ExportFormat, ctx: ExportContext): void {
  download(serialize(rows, format, ctx), `super-line-${ctx.mode}-${stampOf(ctx.now)}.${format}`, MIME[format])
}
