import * as React from 'react'
import type { ClientTapEvent } from '@super-line/core'
import { eventName, formatBytes, formatClock, formatMs, isProblem } from '../lib/labels.js'
import type { Entry } from '../lib/reduce.js'
import { Divider, Follow, Wire } from './rows.js'

/** Direction glyph — outbound and inbound have to separate at a glance while scrolling fast. */
const arrow = (event: ClientTapEvent): string => {
  if (event.k === 'frame') return event.dir === 'out' ? '▲' : '▼'
  if (event.k === 'conn') return '⚡'
  return '·'
}

const tone = (event: ClientTapEvent): string => {
  if (isProblem(event)) return 'text-[var(--color-bad)]'
  if (event.k === 'frame') return event.dir === 'out' ? 'text-[var(--color-out)]' : 'text-[var(--color-in)]'
  if (event.k === 'conn') return 'text-[var(--color-warn)]'
  return 'text-[var(--color-muted)]'
}

/**
 * Frames mode — one row per wire frame, unmerged.
 *
 * It still reads in English: the wire token moves to a dim chip rather than being the label. A response
 * is named by the request it answers, which is what removes the `res #1` / `res #2` eyeball-matching.
 */
export function Timeline({
  entries,
  answers,
  selected,
  onSelect,
}: {
  entries: Entry[]
  /** Correlation key → the label of the request it answers. */
  answers: Map<string, string>
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
          <FrameRow
            key={entry.seq}
            seq={entry.seq}
            ts={entry.ts}
            event={entry.event}
            answers={answers.get(`${entry.clientId}#${idOf(entry.event) ?? ''}`)}
            latencyMs={entry.latencyMs}
            pending={entry.pending}
            selected={selected === entry.seq}
            onSelect={onSelect}
          />
        ),
      )}
    </Follow>
  )
}

const idOf = (event: ClientTapEvent): number | undefined =>
  event.k === 'frame' && 'i' in event.f ? (event.f as { i?: number }).i : undefined

function FrameRow({
  seq,
  ts,
  event,
  answers,
  latencyMs,
  pending,
  selected,
  onSelect,
}: {
  seq: number
  ts: number
  event: ClientTapEvent
  answers?: string
  latencyMs?: number
  pending?: boolean
  selected: boolean
  onSelect(seq: number): void
}): React.JSX.Element {
  const named = eventName(event, answers)
  const bytes = event.k === 'frame' ? event.bytes : undefined
  return (
    <button
      type="button"
      onClick={() => onSelect(seq)}
      className={`flex w-full items-baseline gap-2 px-2 py-0.5 text-left hover:bg-[var(--color-panel)] ${
        selected ? 'bg-[var(--color-panel)]' : ''
      }`}
    >
      <span className="tabular w-20 shrink-0 text-[var(--color-muted)]">{formatClock(ts)}</span>
      <span className={`w-3 shrink-0 ${tone(event)}`}>{arrow(event)}</span>
      <span className={`shrink-0 ${tone(event)}`}>{named.label}</span>
      <Wire>{named.wire}</Wire>
      {named.detail && <span className="truncate text-[var(--color-muted)]">{named.detail}</span>}
      {pending && <span className="shrink-0 text-[var(--color-warn)]">pending</span>}
      <span className="ml-auto flex shrink-0 items-baseline gap-2 text-[var(--color-muted)]">
        {bytes !== undefined && <span className="tabular">{formatBytes(bytes)}</span>}
        {latencyMs !== undefined && <span className="tabular">{formatMs(latencyMs)}</span>}
      </span>
    </button>
  )
}

export function Empty(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center text-[var(--color-muted)]">Waiting for traffic…</div>
  )
}
