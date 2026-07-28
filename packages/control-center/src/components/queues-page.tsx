import * as React from 'react'
import type { CollectionQuery } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { useInspectorCollection } from '@/hooks/use-inspector-collection'
import { formatTime, formatSpan } from '@/lib/events'
import { MultiSelect, type MultiSelectGroup } from '@/components/multi-select'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { Json } from '@/components/json-view'
import { Play, CheckCircle2, XCircle, Clock, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { QueueJob } from '@super-line/plugin-queue'

function StatusChip({ job }: { job: QueueJob }): React.JSX.Element | null {
  const { status, lastError } = job

  if (lastError) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs text-red-500">
        <XCircle className="h-3.5 w-3.5" />
        <span>Failed</span>
      </div>
    )
  }

  switch (status) {
    case 'completed':
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-xs text-green-500">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>Completed</span>
        </div>
      )
    case 'running':
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-xs text-blue-500">
          <Play className="h-3.5 w-3.5" />
          <span>Running</span>
        </div>
      )
    case 'failed':
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 text-xs text-red-500">
          <XCircle className="h-3.5 w-3.5" />
          <span>Failed</span>
        </div>
      )
    case 'queued':
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-0.5 text-xs text-yellow-500">
          <Clock className="h-3.5 w-3.5" />
          <span>Queued</span>
        </div>
      )
    case 'cancelled':
      return (
        <div className="inline-flex items-center gap-1.5 rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2.5 py-0.5 text-xs text-zinc-500">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>Cancelled</span>
        </div>
      )
  }
  return null
}

/** Newest-N window the page holds live. Retention keeps completed jobs for a day and failures for a week, so
 * an unbounded subscription would both scan and re-sort the whole table on every change. */
const JOB_WINDOW = 500
const JOB_QUERY: CollectionQuery = { orderBy: [{ field: 'createdAt', dir: 'desc' }], limit: JOB_WINDOW }

export function QueuesPage({ client }: { client: InspectorClient | null }): React.JSX.Element {
  const { rows: jobs } = useInspectorCollection<QueueJob>(client, 'queueJobs', JOB_QUERY)

  const [selectedQueues, setSelectedQueues] = React.useState<Set<string>>(new Set())
  const [selectedStatus, setSelectedStatus] = React.useState<Set<string>>(new Set())
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null)
  
  const uniqueQueues = React.useMemo(() => Array.from(new Set(jobs.map(j => j.queue))).sort(), [jobs])
  const queueGroups: MultiSelectGroup[] = [
    {
      label: 'Queues',
      options: uniqueQueues.map(q => ({ value: q, label: q }))
    }
  ]
  const statusGroups: MultiSelectGroup[] = [
    {
      label: 'Status',
      options: [
        { value: 'queued', label: 'Queued' },
        { value: 'running', label: 'Running' },
        { value: 'completed', label: 'Completed' },
        { value: 'failed', label: 'Failed' },
        { value: 'cancelled', label: 'Cancelled' },
      ]
    }
  ]
  
  const filteredJobs = React.useMemo(() => {
    return jobs
      .filter(j => selectedQueues.size === 0 || selectedQueues.has(j.queue))
      .filter(j => selectedStatus.size === 0 || selectedStatus.has(j.status))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [jobs, selectedQueues, selectedStatus])
  
  const activeJob = selectedJobId ? jobs.find(j => j.id === selectedJobId) : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center justify-between border-b bg-card px-4 py-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Background Jobs Monitor</h1>
          <p className="mt-1 flex gap-4 text-sm text-muted-foreground">
            <span><strong className="text-foreground">{jobs.length}</strong> Jobs{jobs.length >= JOB_WINDOW ? ' (newest)' : ''}</span>
            <span><strong className="text-foreground">{jobs.filter(j => j.status === 'running').length}</strong> Active Workers</span>
            <span><strong className="text-foreground">{jobs.length ? Math.round((jobs.filter(j => j.status === 'failed').length / jobs.length) * 100) : 0}%</strong> Error Rate</span>
          </p>
        </div>
        
        <div className="flex items-center gap-4 rounded-xl border bg-background/50 p-2 shadow-sm backdrop-blur-sm">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-muted-foreground font-semibold px-1">Queues</span>
            <MultiSelect label="Queues" groups={queueGroups} selected={selectedQueues} onChange={setSelectedQueues} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-muted-foreground font-semibold px-1">Status</span>
            <MultiSelect label="Status" groups={statusGroups} selected={selectedStatus} onChange={setSelectedStatus} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-muted-foreground font-semibold px-1">Date Range</span>
            <div className="inline-flex h-[26px] items-center rounded-md border border-border bg-accent/20 px-3 text-xs text-muted-foreground">
              Oct 20 - Oct 27
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-muted-foreground font-semibold px-1">Cycle Time</span>
            <div className="inline-flex h-[26px] items-center gap-2 rounded-md px-1 text-xs">
              <span className="text-[10px] text-muted-foreground">0s</span>
              <div className="h-1.5 w-24 rounded-full bg-accent relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 w-full bg-primary/40 rounded-full"></div>
                <div className="absolute inset-y-0 left-0 w-3/4 bg-primary rounded-full"></div>
              </div>
              <span className="text-[10px] text-muted-foreground">Max</span>
            </div>
          </div>
        </div>
      </div>
      
      <div className="flex-1 overflow-auto bg-[#09090b] p-4">
        <div className="rounded-xl border bg-card/50 shadow-sm backdrop-blur-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/20 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">#</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Queue</th>
                <th className="px-4 py-3 font-medium">Summary</th>
                <th className="px-4 py-3 font-medium">Node</th>
                <th className="px-4 py-3 font-medium">Cycle Time</th>
                <th className="px-4 py-3 font-medium">Created At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No jobs found
                  </td>
                </tr>
              ) : null}
              {filteredJobs.map((job, idx) => (
                <tr 
                  key={job.id} 
                  onClick={() => setSelectedJobId(job.id)}
                  className={cn(
                    "cursor-pointer transition-colors hover:bg-accent/40",
                    selectedJobId === job.id && "bg-accent/60"
                  )}
                >
                  <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                  <td className="px-4 py-3"><StatusChip job={job} /></td>
                  <td className="px-4 py-3">
                    <span className="rounded-md bg-accent/50 px-2 py-1 text-xs font-mono">{job.queue}</span>
                  </td>
                  <td className="px-4 py-3 font-medium truncate max-w-[200px]">
                    {job.id}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                    {/* node attribution is cleared when a job settles, so this shows only for running jobs */}
                    {job.nodeKey ?? '--'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {job.finishedAt && job.startedAt ? formatSpan(job.finishedAt - job.startedAt) : '--'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                    {formatTime(job.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      
      {activeJob && (
        <DetailPanel label="Job Details" onClose={() => setSelectedJobId(null)}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Job Details</h2>
            <Button variant="ghost" size="sm" onClick={() => setSelectedJobId(null)}>
              Close
            </Button>
          </div>
          
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <div className="rounded-md border bg-card/40 px-2.5 py-1 text-xs font-mono text-muted-foreground">
              {activeJob.id}
            </div>
            <StatusChip job={activeJob} />
            <div className="rounded-md border bg-card/40 px-2.5 py-1 text-xs font-mono text-muted-foreground">
              {activeJob.nodeKey ?? 'unassigned'}
            </div>
            <div className="rounded-md border bg-card/40 px-2.5 py-1 text-xs font-mono text-muted-foreground">
              Attempt: {activeJob.attempt}/{activeJob.maxAttempts}
            </div>
          </div>
          
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Input</h3>
              <div className="rounded-md border bg-card/50 overflow-hidden">
                <Json data={activeJob.input} className="max-h-96" />
              </div>
            </div>
            
            {activeJob.result !== undefined && (
              <div>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Output</h3>
                <div className="rounded-md border bg-card/50 overflow-hidden">
                  <Json data={activeJob.result} className="max-h-96" />
                </div>
              </div>
            )}
            
            {activeJob.lastError !== undefined && (
              <div>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-destructive">Last Error</h3>
                <div className="rounded-md border border-destructive/30 bg-destructive/10 overflow-hidden">
                  <Json data={activeJob.lastError} className="max-h-96" />
                </div>
              </div>
            )}
          </div>
        </DetailPanel>
      )}
    </div>
  )
}
