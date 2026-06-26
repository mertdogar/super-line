import * as React from 'react'
import { ChevronRight, Pause, Play, X } from 'lucide-react'
import type { ConnDescriptor, InspectorEnvelope, InspectorEvent, NodeStat } from '@super-line/core'
import {
  ALL_EVENT_TYPES,
  barFraction,
  emptyFilters,
  eventCategory,
  eventColor,
  eventPayload,
  eventWire,
  eventWireFamilies,
  filtersActive,
  formatBytes,
  formatDuration,
  formatTime,
  latencyColor,
  latencyMsToSlider,
  latencyOf,
  matchesFilters,
  sizeBytesToSlider,
  sizeColor,
  sliderToLatencyFilter,
  sliderToSizeFilter,
  requestTimes,
  summarizeEvent,
  TIME_WINDOWS,
  windowAnchor,
  type FeedCategory,
  type FeedFilters,
  type FeedResolver,
} from '@/lib/events'
import { transportsOf, type TransportFamily } from '@/lib/transport'
import { MiniBar } from '@/components/mini-bar'
import { MultiSelect, type MultiSelectGroup } from '@/components/multi-select'
import { Slider } from '@/components/ui/slider'
import { Json } from '@/components/json-view'
import { cn } from '@/lib/utils'

const CATEGORIES: { id: FeedCategory; label: string }[] = [
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'requests', label: 'Requests' },
  { id: 'events', label: 'Events' },
  { id: 'stores', label: 'Store' },
]

const WIRE_LABELS: Record<TransportFamily, string> = {
  websocket: 'WebSocket',
  http: 'HTTP',
  libp2p: 'libp2p',
  loopback: 'Loopback',
  unknown: 'unknown',
}

const fmtMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

/** Options for a dynamic filter, with any selected-but-vanished values kept so they stay uncheckable. */
function optionsWithSelected<T extends string>(
  options: { value: T; label: string }[],
  selected: Set<T>,
  labelFor: (v: T) => string,
): { value: T; label: string }[] {
  const present = new Set(options.map((o) => o.value))
  const stale = [...selected].filter((v) => !present.has(v)).map((v) => ({ value: v, label: labelFor(v) }))
  return [...options, ...stale]
}

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
  maxBytes,
  maxLatency,
}: {
  env: InspectorEnvelope
  resolver: FeedResolver
  summary: string
  latency?: number
  maxBytes: number
  maxLatency: number
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
        <td className="px-3 py-1.5">
          {env.byteSize === undefined ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <MiniBar
              fraction={barFraction(env.byteSize, maxBytes)}
              color={sizeColor(env.byteSize)}
              label={formatBytes(env.byteSize)}
            />
          )}
        </td>
        <td className="px-3 py-1.5">
          {latency === undefined ? (
            <span className="text-xs text-muted-foreground">—</span>
          ) : (
            <MiniBar fraction={barFraction(latency, maxLatency)} color={latencyColor(latency)} label={`${latency} ms`} />
          )}
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
  topology = [],
}: {
  events: InspectorEnvelope[]
  connections?: ConnDescriptor[]
  topology?: NodeStat[]
}): React.JSX.Element {
  const [paused, setPaused] = React.useState(false)
  const [frozen, setFrozen] = React.useState<InspectorEnvelope[]>([])
  const [frozenAt, setFrozenAt] = React.useState<number | null>(null)
  const [filters, setFilters] = React.useState<FeedFilters>(emptyFilters)
  const [sort, setSort] = React.useState<Sort | null>(null)
  const patch = (p: Partial<FeedFilters>): void => setFilters((f) => ({ ...f, ...p }))

  // freeze the view AND the time-window anchor, so a paused "last 15s" doesn't drain as real time passes
  const freeze = (): void => {
    setFrozen(events)
    setFrozenAt(Date.now())
    setPaused(true)
  }
  const togglePause = (): void => {
    if (paused) setPaused(false)
    else freeze()
  }
  // sorting only makes sense on a frozen view (live order is newest-first), so a sort click also pauses.
  // desc → asc → off; clicking a new column starts at desc (size-desc is the headline use)
  const onSort = (col: SortCol): void => {
    if (!paused) freeze()
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

  // filter option sources: types are fixed (grouped by category); nodes from topology; wires from live conns.
  // Node/wire option lists keep any selected-but-vanished value so a stale filter stays uncheckable.
  const typeGroups: MultiSelectGroup[] = CATEGORIES.map((c) => ({
    label: c.label,
    options: ALL_EVENT_TYPES.filter((t) => eventCategory(t) === c.id).map((t) => ({ value: t, label: t })),
  }))
  const nodeGroups: MultiSelectGroup[] = [
    {
      label: '',
      options: optionsWithSelected(
        topology.map((n) => ({ value: n.nodeId, label: n.nodeName })),
        filters.nodes,
        (id) => resolver.nodeName(id),
      ),
    },
  ]
  const wireFamilies = transportsOf(connections).map((w) => w.family)
  const wireGroups: MultiSelectGroup<TransportFamily>[] = [
    {
      label: '',
      options: optionsWithSelected(
        wireFamilies.map((fam) => ({ value: fam, label: WIRE_LABELS[fam] })),
        filters.wires,
        (fam) => WIRE_LABELS[fam],
      ),
    },
  ]

  // while live with a relative time window, advance the wall-clock anchor on a timer even if no new
  // events arrive — otherwise a stalled feed freezes "last 15s" at the last event's render time
  const [, forceTick] = React.useState(0)
  const windowing = !paused && filters.windowMs !== null
  React.useEffect(() => {
    if (!windowing) return
    const id = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [windowing])

  const source = paused ? frozen : events
  // request emit-times over the whole window, so a response can pair even if its request is filtered out
  const reqTimes = React.useMemo(() => requestTimes(source), [source])
  const nowAnchor = windowAnchor(paused, frozenAt, Date.now()) // live → real now; paused → freeze time

  const rows = source
    .map((en) => ({
      en,
      summary: summarizeEvent(en.event, resolver),
      latency: latencyOf(en, reqTimes),
      families: eventWireFamilies(en.event, resolver),
    }))
    .filter((r) =>
      matchesFilters(r.en, filters, {
        summary: r.summary,
        latency: r.latency,
        families: r.families,
        nowAnchor,
      }),
    )
  if (sort && paused) {
    const val = (r: (typeof rows)[number]): number =>
      sort.col === 'time' ? r.en.ts : sort.col === 'size' ? r.en.byteSize ?? -1 : r.latency ?? -1
    rows.sort((a, b) => (val(a) - val(b)) * (sort.dir === 'asc' ? 1 : -1))
  }
  // in-view maxes the bars scale against (relative length); recomputed as filters/data change
  const maxBytes = rows.reduce((m, r) => Math.max(m, r.en.byteSize ?? 0), 0)
  const maxLatency = rows.reduce((m, r) => Math.max(m, r.latency ?? 0), 0)

  // latency/size sliders work in 0..1000 positions mapped log-wise to value; full span = filter off
  const latPos: [number, number] = filters.latency
    ? [
        Math.round(latencyMsToSlider(filters.latency[0]) * 1000),
        Math.round(latencyMsToSlider(filters.latency[1]) * 1000),
      ]
    : [0, 1000]
  const onLatency = (v: number[]): void => patch({ latency: sliderToLatencyFilter(v[0] ?? 0, v[1] ?? 1000) })
  const sizePos: [number, number] = filters.size
    ? [Math.round(sizeBytesToSlider(filters.size[0]) * 1000), Math.round(sizeBytesToSlider(filters.size[1]) * 1000)]
    : [0, 1000]
  const onSize = (v: number[]): void => patch({ size: sliderToSizeFilter(v[0] ?? 0, v[1] ?? 1000) })

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={filters.text}
          onChange={(e) => patch({ text: e.target.value })}
          placeholder="Filter…"
          className="w-36 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <MultiSelect label="Types" groups={typeGroups} selected={filters.types} onChange={(s) => patch({ types: s })} />
        {topology.length > 1 || filters.nodes.size > 0 ? (
          <MultiSelect label="Nodes" groups={nodeGroups} selected={filters.nodes} onChange={(s) => patch({ nodes: s })} />
        ) : null}
        {wireFamilies.length > 1 || filters.wires.size > 0 ? (
          <MultiSelect label="Wires" groups={wireGroups} selected={filters.wires} onChange={(s) => patch({ wires: s })} />
        ) : null}
        <div className="inline-flex overflow-hidden rounded-md border text-xs">
          {TIME_WINDOWS.map((w) => (
            <button
              key={w.label}
              onClick={() => patch({ windowMs: w.ms })}
              className={cn(
                'px-2 py-1 transition-colors',
                filters.windowMs === w.ms ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border px-2 py-1">
          <span className="text-xs text-muted-foreground">Latency</span>
          <Slider value={latPos} min={0} max={1000} step={1} onValueChange={onLatency} className="w-28" />
          <span className="w-24 text-right text-[10px] tabular-nums text-muted-foreground">
            {filters.latency ? `${fmtMs(filters.latency[0])}–${fmtMs(filters.latency[1])}` : 'any'}
          </span>
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border px-2 py-1">
          <span className="text-xs text-muted-foreground">Size</span>
          <Slider value={sizePos} min={0} max={1000} step={1} onValueChange={onSize} className="w-28" />
          <span className="w-24 text-right text-[10px] tabular-nums text-muted-foreground">
            {filters.size ? `${formatBytes(Math.round(filters.size[0]))}–${formatBytes(Math.round(filters.size[1]))}` : 'any'}
          </span>
        </div>
        {filtersActive(filters) ? (
          <button
            onClick={() => setFilters(emptyFilters())}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
          >
            <X className="h-3 w-3" />
            Reset
          </button>
        ) : null}
        <button
          onClick={togglePause}
          className={cn(
            'ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
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
                <SortTh col="size" label="size" sort={sort} onSort={onSort} align="left" />
                <SortTh col="latency" label="latency" sort={sort} onSort={onSort} align="left" />
                <th className="px-3 py-2 font-medium">wire</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <FeedRow
                  key={keyOf(r.en)}
                  env={r.en}
                  resolver={resolver}
                  summary={r.summary}
                  latency={r.latency}
                  maxBytes={maxBytes}
                  maxLatency={maxLatency}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
