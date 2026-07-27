import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import type { z } from 'zod'
import { client } from './client.js'
import type { jobSummarySchema } from './dashboard-contract.js'

type Job = z.infer<typeof jobSummarySchema>

const STATUS_ORDER: Job['status'][] = ['running', 'queued', 'completed', 'failed', 'cancelled']

const time = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const duration = (job: Job): string => {
  const end = job.finishedAt ?? Date.now()
  const start = job.startedAt ?? job.createdAt
  const milliseconds = Math.max(0, end - start)
  if (milliseconds < 1_000) return `${milliseconds} ms`
  return `${(milliseconds / 1_000).toFixed(1)} s`
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'The queue request failed'

export function App(): React.JSX.Element {
  const [jobs, setJobs] = useState<Job[]>([])
  const [reportId, setReportId] = useState('')
  const [createdJobId, setCreatedJobId] = useState<string>()
  const [lastUpdated, setLastUpdated] = useState<number>()
  const [pollError, setPollError] = useState<string>()
  const [submitError, setSubmitError] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const next = await client.listJobs()
      setJobs(next)
      setLastUpdated(Date.now())
      setPollError(undefined)
    } catch (refreshError) {
      setPollError(errorMessage(refreshError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    let timeout: number | undefined
    const poll = async () => {
      await refresh()
      if (active) timeout = window.setTimeout(() => void poll(), 2_000)
    }
    void poll()
    return () => {
      active = false
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [refresh])

  const counts = useMemo(
    () =>
      STATUS_ORDER.map((status) => ({
        status,
        count: jobs.filter((job) => job.status === status).length,
      })),
    [jobs],
  )

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextReportId = reportId.trim()
    if (!nextReportId || creating) return

    setCreating(true)
    setSubmitError(undefined)
    try {
      const created = await client.createReportJob({ reportId: nextReportId })
      setCreatedJobId(created.jobId)
      setReportId('')
      await refresh()
    } catch (createError) {
      setSubmitError(errorMessage(createError))
    } finally {
      setCreating(false)
    }
  }

  const controlCenterUrl = `${window.location.protocol}//${window.location.hostname}:8081`

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">SUPER-LINE / QUEUE CLUSTER</p>
          <h1>Dispatch ledger</h1>
        </div>
        <div className="header-actions">
          <span
            className={`connection ${pollError ? 'connection--down' : loading ? 'connection--pending' : ''}`}
          >
            <span aria-hidden="true" />
            {pollError ? 'Connection interrupted' : loading ? 'Connecting to cluster' : 'Polling every 2 seconds'}
          </span>
          <a href={controlCenterUrl} target="_blank" rel="noreferrer">
            Open Control Center ↗
          </a>
        </div>
      </header>

      <section className="rail-summary" aria-label="Recent queue status summary">
        <div className="rail-title">
          <span>REPORT QUEUE / RECENT 50</span>
          <strong>2</strong>
          <small>cluster-wide slots</small>
        </div>
        <div className="tracks" aria-hidden="true">
          <span className={jobs.some((job) => job.status === 'running') ? 'track track--active' : 'track'} />
          <span
            className={jobs.filter((job) => job.status === 'running').length > 1 ? 'track track--active' : 'track'}
          />
        </div>
        <div className="counters">
          {counts.map(({ status, count }) => (
            <div key={status}>
              <span>{status}</span>
              <strong>{String(count).padStart(2, '0')}</strong>
            </div>
          ))}
        </div>
      </section>

      <div className="workspace">
        <aside className="dispatch-panel">
          <div>
            <p className="section-number">01 / DISPATCH</p>
            <h2>Create report job</h2>
            <p className="panel-copy">
              Submit through the typed request surface. Postgres remains the queue authority and either node may
              claim the work.
            </p>
          </div>

          <form onSubmit={submit}>
            <label htmlFor="report-id">Report identifier</label>
            <input
              id="report-id"
              value={reportId}
              onChange={(event) => setReportId(event.target.value)}
              placeholder="e.g. revenue-eu-july"
              maxLength={80}
              autoComplete="off"
            />
            <button type="submit" disabled={!reportId.trim() || creating}>
              {creating ? 'Dispatching…' : 'Dispatch job'}
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <div className="receipt" aria-live="polite">
            <span>LAST RECEIPT</span>
            <code>{createdJobId ?? 'No browser job dispatched yet'}</code>
          </div>

          {submitError && <p className="request-error">{submitError}</p>}
        </aside>

        <section className="ledger-panel">
          <div className="ledger-heading">
            <div>
              <p className="section-number">02 / OBSERVE</p>
              <h2>Recent work</h2>
            </div>
            <span>{lastUpdated ? `Updated ${time.format(lastUpdated)}` : 'Waiting for cluster'}</span>
          </div>

          <div className="ledger-labels" aria-hidden="true">
            <span>Job / source</span>
            <span>Status</span>
            <span>Attempt</span>
            <span>Worker / duration</span>
            <span>Created</span>
          </div>

          <div className="job-list" aria-live="polite">
            {loading && <div className="empty-state">Connecting to the queue cluster…</div>}
            {!loading && jobs.length === 0 && <div className="empty-state">No jobs in the ledger yet.</div>}
            {jobs.map((job) => (
              <article
                key={job.id}
                className={`job-row job-row--${job.status} ${createdJobId === job.id ? 'job-row--new' : ''}`}
              >
                <div className="job-identity">
                  <strong>{job.reportId}</strong>
                  <code>{job.id}</code>
                  <small>{job.source}</small>
                </div>
                <div>
                  <span className={`status status--${job.status}`}>{job.status}</span>
                </div>
                <div className="attempt">
                  <strong>{job.attempt}</strong>
                  <span>/ {job.maxAttempts}</span>
                </div>
                <div className="worker">
                  <strong>{job.processedBy ?? (job.status === 'running' ? 'claim active' : 'unassigned')}</strong>
                  <span>{duration(job)}</span>
                </div>
                <time dateTime={new Date(job.createdAt).toISOString()}>{time.format(job.createdAt)}</time>
                {job.lastError && <p className="job-error">{job.lastError.message}</p>}
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
