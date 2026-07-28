import * as React from 'react'
import { formatBytes, formatClock, formatMs } from '../lib/labels.js'
import type { OpEntry, Operation } from '../lib/operations.js'
import { Divider, Follow, Wire } from './rows.js'
import { Empty } from './Timeline.js'

const STATUS: Record<Operation['status'], { glyph: string; tone: string }> = {
  pending: { glyph: '…', tone: 'text-[var(--color-warn)]' },
  ok: { glyph: '✓', tone: 'text-[var(--color-in)]' },
  error: { glyph: '✕', tone: 'text-[var(--color-bad)]' },
}

const DIR: Record<Operation['dir'], string> = { out: '▲', in: '▼' }

/**
 * Activity mode — one row per logical operation.
 *
 * Rows are anchored at the time the operation STARTED and update in place as their acks land, so the
 * list keeps true chronological order rather than reshuffling when a slow request finally answers.
 */
export function Activity({
  entries,
  selected,
  onSelect,
}: {
  entries: OpEntry[]
  selected?: number
  onSelect(seq: number): void
}): React.JSX.Element {
  if (!entries.length) return <Empty />

  return (
    <Follow count={entries.length}>
      {entries.map((entry) =>
        entry.type === 'divider' ? (
          <Divider key={`d${entry.kind}${entry.seq}`} entry={entry} />
        ) : (
          <Row key={entry.seq} op={entry} selected={selected === entry.seq} onSelect={onSelect} />
        ),
      )}
    </Follow>
  )
}

function Row({
  op,
  selected,
  onSelect,
}: {
  op: Operation
  selected: boolean
  onSelect(seq: number): void
}): React.JSX.Element {
  const status = STATUS[op.status]
  const size =
    op.reqBytes !== undefined && op.resBytes !== undefined
      ? `${formatBytes(op.reqBytes)}→${formatBytes(op.resBytes)}`
      : formatBytes(op.reqBytes ?? op.resBytes)

  return (
    <button
      type="button"
      onClick={() => onSelect(op.seq)}
      className={`block w-full px-2 py-0.5 text-left hover:bg-[var(--color-panel)] ${
        selected ? 'bg-[var(--color-panel)]' : ''
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="tabular w-20 shrink-0 text-[var(--color-muted)]">{formatClock(op.ts)}</span>
        <span className={`w-3 shrink-0 ${op.dir === 'out' ? 'text-[var(--color-out)]' : 'text-[var(--color-in)]'}`}>
          {DIR[op.dir]}
        </span>
        <span className={`w-3 shrink-0 ${status.tone}`}>{status.glyph}</span>
        <span className={op.problem ? 'text-[var(--color-bad)]' : ''}>{op.label}</span>
        <Wire>{op.wire}</Wire>
        {op.detail && <span className="truncate text-[var(--color-muted)]">{op.detail}</span>}

        <span className="ml-auto flex shrink-0 items-baseline gap-2 tabular text-[var(--color-muted)]">
          {op.rows !== undefined && <span>{op.rows === 1 ? '1 row' : `${op.rows} rows`}</span>}
          {/* time spent waiting for a writable socket is invisible on the wire, so it is called out */}
          {op.queuedMs !== undefined && op.queuedMs > 0 && (
            <span className="text-[var(--color-warn)]">queued {formatMs(op.queuedMs)}</span>
          )}
          {size && <span>{size}</span>}
          {op.latencyMs !== undefined && <span>{formatMs(op.latencyMs)}</span>}
        </span>
      </div>

      {op.children.length > 0 && (
        <div className="pl-[6.5rem] text-[11px] text-[var(--color-muted)]">
          {op.children.map((c, i) => (
            <div key={i}>└ {c}</div>
          ))}
        </div>
      )}
    </button>
  )
}
