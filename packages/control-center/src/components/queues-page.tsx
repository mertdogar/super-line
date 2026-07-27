import * as React from 'react'
import { ChevronRight, RefreshCw, X, SlidersHorizontal, TriangleAlert, Copy, Check } from 'lucide-react'
import { andFilters, eq, gte, ilike, isIn, type Expr } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { QUEUE_JOBS_COLLECTION } from '@/lib/queue'
import { formatTime, formatDuration, TIME_WINDOWS, latencyMsToSlider, latencySliderToMs } from '@/lib/events'
import { MiniBar } from '@/components/mini-bar'
import { MultiSelect, type MultiSelectGroup } from '@/components/multi-select'
import { Slider } from '@/components/ui/slider'
import { Json } from '@/components/json-view'
import { DetailPanel } from '@/components/detail-panel'
import { cn, clickable, plural } from '@/lib/utils'

export type QueueJob = {
  id: string
  queue: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  input: unknown
  result?: unknown
  lastError?: { name: string; message: string; attempt: number; at: number }
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  nodeId?: string
  nodeKey?: string
  attempt: number
  maxAttempts: number
}

const CHIP_BTN =
  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function RangePopover({
  value,
  pos,
  onChange,
}: {
  value: [number, number] | null
  pos: [number, number]
  onChange: (v: number[]) => void
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const active = value !== null
  const fmtMs = (ms: number): string =>
    ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(CHIP_BTN, 'hover:bg-accent/40', active ? 'text-foreground' : 'text-muted-foreground')}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Cycle Time
        {active ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
      </button>
      {open ? (
        <div className="absolute left-0 z-20 mt-1 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
              <span>Cycle Time</span>
              <span className="tabular-nums normal-case">{value ? `${fmtMs(value[0])}–${fmtMs(value[1])}` : 'any'}</span>
            </div>
            <Slider value={pos} min={0} max={1000} step={1} onValueChange={onChange} />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function statusColor(status: QueueJob['status']): string {
  switch (status) {
    case 'completed': return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
    case 'failed': return 'bg-destructive/15 text-destructive border-destructive/30'
    case 'running': return 'bg-primary/15 text-primary border-primary/30'
    case 'queued': return 'bg-muted text-muted-foreground border-border'
    case 'cancelled': return 'bg-orange-500/15 text-orange-500 border-orange-500/30'
  }
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text).catch(() => {})
}

function JobDetail({ job, onClose }: { job: QueueJob; onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  
  const handleCopy = () => {
    copyToClipboard(JSON.stringify(job.input, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const cycleTime = job.finishedAt ? job.finishedAt - job.createdAt : job.startedAt ? Date.now() - job.createdAt : undefined

  return (
    <DetailPanel label="Job Details" onClose={onClose}>
      <div className="flex items-center justify-between border-b pb-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Job Details</h2>
          <div className="mt-1 font-mono text-xs text-foreground">id: {job.id}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-5">
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Queue</h3>
          <div className="text-sm">{job.queue}</div>
        </div>
        
        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</h3>
          <div className="flex items-center gap-2">
            <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize', statusColor(job.status))}>
              {job.status}
            </span>
            <span className="text-xs text-muted-foreground">(Attempt {job.attempt}/{job.maxAttempts})</span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Input</h3>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 rounded text-[10px] text-muted-foreground hover:text-foreground"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          <div className="rounded-md border bg-card/40 p-2 max-h-60 overflow-auto">
            <Json data={job.input} />
          </div>
        </div>

        {job.result !== undefined && (
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Result</h3>
            <div className="rounded-md border bg-card/40 p-2 max-h-60 overflow-auto">
              <Json data={job.result} />
            </div>
          </div>
        )}

        {job.lastError && (
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Last Error</h3>
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2">
              <div className="text-xs font-semibold text-destructive">{job.lastError.name}</div>
              <div className="mt-1 text-xs text-destructive/80 font-mono whitespace-pre-wrap">{job.lastError.message}</div>
            </div>
          </div>
        )}

        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Timing</h3>
          <div className="grid grid-cols-2 gap-y-1.5 text-xs">
            <div className="text-muted-foreground">Created:</div>
            <div>{formatTime(job.createdAt)}</div>
            <div className="text-muted-foreground">Started:</div>
            <div>{job.startedAt ? formatTime(job.startedAt) : '—'}</div>
            <div className="text-muted-foreground">Finished:</div>
            <div>{job.finishedAt ? formatTime(job.finishedAt) : '—'}</div>
            <div className="text-muted-foreground">Cycle Time:</div>
            <div>{cycleTime !== undefined ? `${cycleTime}ms` : '—'}</div>
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Node</h3>
          <div className="text-xs">
            {job.nodeId ? (
              <>
                {job.nodeId.slice(0, 8)} <span className="text-muted-foreground">(nodeKey: {job.nodeKey?.slice(0, 8) ?? '—'})</span>
              </>
            ) : '—'}
          </div>
        </div>
      </div>
    </DetailPanel>
  )
}

function summaryString(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') return JSON.stringify(input)
  return String(input)
}

export function QueuesPage({ client }: { client: InspectorClient | null }): React.JSX.Element {
  const [jobs, setJobs] = React.useState<QueueJob[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [text, setText] = React.useState('')
  const [queues, setQueues] = React.useState<Set<string>>(new Set())
  const [statuses, setStatuses] = React.useState<Set<string>>(new Set())
  const [windowMs, setWindowMs] = React.useState<number | null>(null)
  const [cycleTime, setCycleTime] = React.useState<[number, number] | null>(null)

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const selectedJob = jobs.find((j) => j.id === selectedId)

  // Derived unique queues for the multiselect
  const availableQueues = React.useMemo(() => {
    return Array.from(new Set(jobs.map(j => j.queue))).sort()
  }, [jobs])

  const queueGroups: MultiSelectGroup[] = [
    {
      label: 'Queues',
      options: availableQueues.map(q => ({ value: q, label: q }))
    }
  ]
  const statusGroups: MultiSelectGroup[] = [
    {
      label: 'Statuses',
      options: ['queued', 'running', 'completed', 'failed', 'cancelled'].map(s => ({ value: s, label: s }))
    }
  ]

  const load = React.useCallback(() => {
    if (!client) return
    setLoading(true)
    client.queryCollection(QUEUE_JOBS_COLLECTION, { limit: 200, orderBy: [{ field: 'createdAt', dir: 'desc' }] })
      .then((data) => {
        setJobs(data as QueueJob[])
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [client])

  React.useEffect(() => {
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [load])

  const nowAnchor = Date.now()

  const rows = jobs.map(j => {
    const cycle = j.finishedAt ? j.finishedAt - j.createdAt : j.startedAt ? nowAnchor - j.createdAt : undefined
    return { ...j, cycleTime: cycle, summary: summaryString(j.input) }
  }).filter(j => {
    if (text && !j.summary.toLowerCase().includes(text.toLowerCase()) && !j.queue.toLowerCase().includes(text.toLowerCase())) return false
    if (queues.size > 0 && !queues.has(j.queue)) return false
    if (statuses.size > 0 && !statuses.has(j.status)) return false
    if (windowMs !== null && j.createdAt < nowAnchor - windowMs) return false
    if (cycleTime !== null) {
      if (j.cycleTime === undefined) return false
      if (j.cycleTime < cycleTime[0] || j.cycleTime > cycleTime[1]) return false
    }
    return true
  })

  const maxCycleTime = rows.reduce((m, r) => Math.max(m, r.cycleTime ?? 0), 0)

  // cycle time slider uses the latency mapping from events
  const cyclePos: [number, number] = cycleTime
    ? [Math.round(latencyMsToSlider(cycleTime[0]) * 1000), Math.round(latencyMsToSlider(cycleTime[1]) * 1000)]
    : [0, 1000]

  const onCycleTimeChange = (v: number[]) => {
    if (v[0]! <= 0 && v[1]! >= 1000) setCycleTime(null)
    else setCycleTime([latencySliderToMs(v[0]! / 1000), latencySliderToMs(v[1]! / 1000)])
  }

  const filtersActive = text !== '' || queues.size > 0 || statuses.size > 0 || windowMs !== null || cycleTime !== null

  const resetFilters = () => {
    setText('')
    setQueues(new Set())
    setStatuses(new Set())
    setWindowMs(null)
    setCycleTime(null)
  }

  return (
    <div className="flex h-full flex-col gap-2 relative">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter input/queue…"
          className="w-36 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <MultiSelect label="Queues" groups={queueGroups} selected={queues} onChange={setQueues} />
        <MultiSelect label="Statuses" groups={statusGroups} selected={statuses} onChange={setStatuses} />
        
        <span className="mx-0.5 hidden h-5 w-px shrink-0 bg-border sm:block" aria-hidden="true" />

        <div className="inline-flex overflow-hidden rounded-md border text-xs">
          {TIME_WINDOWS.map((w) => (
            <button
              type="button"
              key={w.label}
              onClick={() => setWindowMs(w.ms)}
              className={cn(
                'px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                windowMs === w.ms ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40',
              )}
            >
              {w.label}
            </button>
          ))}
        </div>

        <RangePopover value={cycleTime} pos={cyclePos} onChange={onCycleTimeChange} />

        <div className="ml-auto flex items-center gap-1.5">
          {filtersActive ? (
            <button
              type="button"
              onClick={resetFilters}
              className={cn(CHIP_BTN, 'text-muted-foreground hover:bg-accent/40')}
            >
              <X className="h-3 w-3" />
              Reset
            </button>
          ) : null}
          <button
            type="button"
            onClick={load}
            className={cn(CHIP_BTN, 'text-muted-foreground hover:bg-accent/40')}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Failed to load queues — {error}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {jobs.length === 0 ? 'No queue jobs found.' : 'No jobs match the filter.'}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b bg-card/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">status</th>
                <th className="px-3 py-2 font-medium">queue</th>
                <th className="px-3 py-2 font-medium">summary (input)</th>
                <th className="px-3 py-2 font-medium">node</th>
                <th className="px-3 py-2 font-medium">cycle time</th>
                <th className="px-3 py-2 font-medium text-right">created at</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  {...clickable(() => setSelectedId(r.id))}
                  className={cn(
                    'cursor-pointer border-b last:border-0 hover:bg-accent/40',
                    r.status === 'failed' && 'bg-destructive/5 hover:bg-destructive/10',
                    selectedId === r.id && 'bg-accent/60',
                  )}
                >
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize tracking-wide', statusColor(r.status))}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{r.queue}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                    <span className="block max-w-88 truncate">{r.summary}</span>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{r.nodeId ? r.nodeId.slice(0, 8) : '—'}</td>
                  <td className="px-3 py-1.5">
                    {r.cycleTime === undefined ? (
                      <span className="text-xs text-muted-foreground">—</span>
                    ) : (
                      <MiniBar 
                        fraction={maxCycleTime > 0 ? r.cycleTime / maxCycleTime : 0} 
                        color={r.status === 'failed' ? '#f87171' : '#a3e635'} 
                        label={`${r.cycleTime} ms`} 
                      />
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground text-right">
                    {formatTime(r.createdAt)} <span className="opacity-60">· {formatDuration(r.createdAt)} ago</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedJob && (
        <JobDetail job={selectedJob} onClose={() => setSelectedId(null)} />
      )}
    </div>
  )
}
