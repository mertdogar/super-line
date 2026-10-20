import { useState } from 'react'
import { useClient, useEvent, useRequest } from '@super-line/react'
import { usePoll } from '../use-interval'

export function QueuesPanel(): React.JSX.Element {
  const client = useClient()
  const jobs = usePoll(() => client.listJobs(), 1000)
  const schedules = usePoll(() => client.listSchedules(), 1000)

  const { call: enqueue } = useRequest('enqueueReport')
  const { call: cancel } = useRequest('cancelJob')
  const { call: retry } = useRequest('retryJob')
  const { call: setSchedule } = useRequest('setSchedule')
  const { call: trigger } = useRequest('triggerSchedule')

  const [label, setLabel] = useState('report')
  const [failRate, setFailRate] = useState(0.3)
  const [count, setCount] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const run = (op: Promise<unknown>) => {
    setError(null)
    op.catch((err: Error) => setError(err.message))
  }

  // Pushed by whichever node's worker runs YOUR job, routed to this tab through the adapter.
  const [log, setLog] = useState<string[]>([])
  useEvent('jobProgress', (p) =>
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${p.node} · ${p.label}: ${p.text}`, ...prev].slice(0, 30)),
  )

  return (
    <section className="panel">
      <h2>Queues · plugin-queue</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          run(enqueue({ label, failRate, count }))
        }}
      >
        <input value={label} onChange={(e) => setLabel(e.target.value)} />
        <select value={failRate} onChange={(e) => setFailRate(Number(e.target.value))}>
          <option value={0}>never fails</option>
          <option value={0.3}>30% fail</option>
          <option value={1}>always fails</option>
        </select>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {[1, 5, 10].map((n) => (
            <option key={n} value={n}>
              ×{n}
            </option>
          ))}
        </select>
        <button type="submit">Enqueue</button>
      </form>
      <p className="muted">report: concurrency 2 cluster-wide, 3 attempts. Chat “/bot …” feeds the botReply queue.</p>
      {error && <p className="error">{error}</p>}

      <h3>Schedules</h3>
      <ul className="plain">
        {schedules?.map((s) => (
          <li key={s.id}>
            <code>{s.cron}</code> {s.id} → {s.queue}{' '}
            <span className="muted">{s.enabled ? `next ${new Date(s.nextRunAt).toLocaleTimeString()}` : 'paused'}</span>{' '}
            <button className="small" onClick={() => run(setSchedule({ id: s.id, enabled: !s.enabled }))}>
              {s.enabled ? 'pause' : 'resume'}
            </button>{' '}
            <button className="small" onClick={() => run(trigger({ id: s.id }))}>
              trigger now
            </button>
          </li>
        ))}
      </ul>

      <h3>Jobs</h3>
      <table>
        <thead>
          <tr>
            <th>job</th>
            <th>status</th>
            <th>try</th>
            <th>node</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs?.map((j) => (
            <tr key={j.id} title={j.error}>
              <td>
                {j.queue}: {j.label}
                {j.scheduled && <span className="tag">cron</span>}
              </td>
              <td className={`status ${j.status}`}>{j.status}</td>
              <td>
                {j.attempt}/{j.maxAttempts}
              </td>
              <td>{j.node ?? '—'}</td>
              <td>
                {(j.status === 'queued' || j.status === 'running') && (
                  <button className="small" onClick={() => run(cancel({ jobId: j.id }))}>
                    cancel
                  </button>
                )}
                {(j.status === 'failed' || j.status === 'cancelled') && (
                  <button className="small" onClick={() => run(retry({ jobId: j.id }))}>
                    retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Progress events · jobProgress</h3>
      <ul className="plain log">
        {log.map((line, i) => (
          <li key={log.length - i}>{line}</li>
        ))}
      </ul>
    </section>
  )
}
