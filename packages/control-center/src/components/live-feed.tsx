import * as React from 'react'
import { ChevronRight, Pause, Play } from 'lucide-react'
import type { ConnDescriptor, InspectorEnvelope, InspectorEvent } from '@super-line/core'
import {
  eventCategory,
  eventColor,
  eventPayload,
  eventWire,
  formatBytes,
  formatDuration,
  formatTime,
  latencyOf,
  requestTimes,
  summarizeEvent,
  type FeedCategory,
  type FeedResolver,
} from '@/lib/events'
import { transportsOf } from '@/lib/transport'
import { Json } from '@/components/json-view'
import { cn } from '@/lib/utils'

const CATEGORIES: { id: FeedCategory; label: string }[] = [
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'requests', label: 'Requests' },
  { id: 'events', label: 'Events' },
  { id: 'stores', label: 'Store' },
]

function WireChip({ event, resolver }: { event: InspectorEvent; resolver: FeedResolver }): React.JSX.Element | null {
  const wire = eventWire(event, resolver)
  if (!wire) return null
  if (wire.kind === 'one') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: wire.color }} />
        {wire.label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
      {wire.parts.map((p) => (
        <span key={p.short} className="inline-flex items-center gap-0.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: p.color }} />
          {p.short}×{p.count}
        </span>
      ))}
    </span>
  )
}

const COL_COUNT = 7

function FeedRow({
  env,
  resolver,
  summary,
  latency,
}: {
  env: InspectorEnvelope
  resolver: FeedResolver
  summary: string
  latency?: number
}): React.JSX.Element {
  const event = env.event
  const [open, setOpen] = React.useState(false)
  const payload = eventPayload(event)
  const hasPayload = payload !== undefined

  return (
    <>
      <tr
        onClick={() => hasPayload && setOpen((v) => !v)}
        className={cn('border-b last:border-0', hasPayload && 'cursor-pointer hover:bg-accent/40')}
      >
        <td className="px-3 py-1.5">
          <span className="inline-flex items-center gap-1.5">
            {hasPayload ? (
              <ChevronRight
                className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
              />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className={cn('h-2 w-2 shrink-0 rounded-full', eventColor(event.type))} />
            <span className="font-mono text-xs text-muted-foreground">{event.type}</span>
          </span>
        </td>
        <td className="px-3 py-1.5 font-mono text-xs">
          <span className="block max-w-[22rem] truncate">{summary}</span>
        </td>
        <td className="px-3 py-1.5 text-xs text-muted-foreground">{resolver.nodeName(env.originNodeId)}</td>
        <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
          {formatTime(env.ts)} <span className="opacity-60">· {formatDuration(env.ts)}</span>
        </td>
        <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{formatBytes(env.byteSize)}</td>
        <td className="px-3 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
          {latency === undefined ? '—' : `${latency} ms`}
        </td>
        <td className="px-3 py-1.5">
          <WireChip event={event} resolver={resolver} />
        </td>
      </tr>
      {open && hasPayload ? (
        <tr className="border-b last:border-0">
          <td colSpan={COL_COUNT} className="px-3 pb-2">
            <Json data={payload} className="max-h-60" />
          </td>
        </tr>
      ) : null}
    </>
  )
}

type SortCol = 'time' | 'size' | 'latency'
type Sort = { col: SortCol; dir: 'asc' | 'desc' }

function SortTh({
  col,
  label,
  sort,
  onSort,
  align = 'right',
}: {
  col: SortCol
  label: string
  sort: Sort | null
  onSort: (col: SortCol) => void
  align?: 'left' | 'right'
}): React.JSX.Element {
  const active = sort?.col === col
  return (
    <th
      onClick={() => onSort(col)}
      className={cn(
        'cursor-pointer select-none px-3 py-2 font-medium hover:text-foreground',
        align === 'right' && 'text-right',
      )}
    >
      {label}
      {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )
}

export function LiveFeed({
  events,
  connections = [],
}: {
  events: InspectorEnvelope[]
  connections?: ConnDescriptor[]
}): React.JSX.Element {
  const [active, setActive] = React.useState<Set<FeedCategory>>(
    () => new Set<FeedCategory>(['lifecycle', 'requests', 'events', 'stores']),
  )
  const [paused, setPaused] = React.useState(false)
  const [frozen, setFrozen] = React.useState<InspectorEnvelope[]>([])
  const [query, setQuery] = React.useState('')
  const [sort, setSort] = React.useState<Sort | null>(null)

  const togglePause = (): void => {
    setPaused((p) => {
      if (!p) setFrozen(events) // freeze the current view
      return !p
    })
  }
  const toggle = (id: FeedCategory): void =>
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // sorting only makes sense on a frozen view (live order is newest-first), so a sort click also pauses.
  // desc → asc → off; clicking a new column starts at desc (size-desc is the headline use)
  const onSort = (col: SortCol): void => {
    if (!paused) {
      setFrozen(events)
      setPaused(true)
    }
    setSort((prev) => (prev?.col !== col ? { col, dir: 'desc' } : prev.dir === 'desc' ? { col, dir: 'asc' } : null))
  }

  // stable per-event key: index keys would mis-bind row expansion state when events prepend
  const keys = React.useRef(new WeakMap<InspectorEnvelope, number>())
  const nextKey = React.useRef(0)
  const keyOf = (en: InspectorEnvelope): number => {
    let k = keys.current.get(en)
    if (k === undefined) {
      k = nextKey.current++
      keys.current.set(en, k)
    }
    return k
  }

  const resolver = React.useMemo<FeedResolver>(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    const nodeNames = new Map(connections.map((c) => [c.nodeId, c.nodeName]))
    return {
      conn: (id) => byId.get(id),
      nodeName: (nodeId) => nodeNames.get(nodeId) ?? nodeId.slice(0, 8),
      roomWires: (room) => transportsOf(connections.filter((c) => c.rooms.includes(room))),
    }
  }, [connections])

  const source = paused ? frozen : events
  // request emit-times over the whole window, so a response can pair even if its request is filtered out
  const reqTimes = React.useMemo(() => requestTimes(source), [source])

  const q = query.trim().toLowerCase()
  const rows = source
    .filter((en) => active.has(eventCategory(en.event.type)))
    .map((en) => ({ en, summary: summarizeEvent(en.event, resolver), latency: latencyOf(en, reqTimes) }))
    .filter((r) => !q || `${r.en.event.type} ${r.summary}`.toLowerCase().includes(q))
  if (sort && paused) {
    const val = (r: (typeof rows)[number]): number =>
      sort.col === 'time' ? r.en.ts : sort.col === 'size' ? r.en.byteSize ?? -1 : r.latency ?? -1
    rows.sort((a, b) => (val(a) - val(b)) * (sort.dir === 'asc' ? 1 : -1))
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => toggle(c.id)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition-colors',
              active.has(c.id)
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40',
            )}
          >
            {c.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="ml-auto w-40 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={togglePause}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
            paused ? 'bg-amber-400/20 text-amber-300' : 'text-muted-foreground hover:bg-accent/40',
          )}
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? 'Paused' : 'Pause'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {events.length === 0 ? 'Waiting for events…' : 'No events match the filter.'}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-card/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">type</th>
                <th className="px-3 py-2 font-medium">summary</th>
                <th className="px-3 py-2 font-medium">node</th>
                <SortTh col="time" label="time" sort={sort} onSort={onSort} align="left" />
                <SortTh col="size" label="size" sort={sort} onSort={onSort} />
                <SortTh col="latency" label="latency" sort={sort} onSort={onSort} />
                <th className="px-3 py-2 font-medium">wire</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <FeedRow key={keyOf(r.en)} env={r.en} resolver={resolver} summary={r.summary} latency={r.latency} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
