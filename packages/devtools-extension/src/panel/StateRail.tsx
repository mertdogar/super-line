import * as React from 'react'
import type { ClientState, PanelState } from '../lib/reduce.js'

const DOT: Record<ClientState['status'], string> = {
  open: 'var(--color-in)',
  connecting: 'var(--color-muted)',
  retrying: 'var(--color-warn)',
  closed: 'var(--color-bad)',
}

const duration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * Derived client-local state — the half of this panel that Control Center structurally cannot show,
 * because none of it crosses the wire.
 */
export function StateRail({ state }: { state: PanelState }): React.JSX.Element {
  // Age has to advance between events, so the rail ticks on its own rather than on new traffic.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="shrink-0 space-y-3 overflow-auto border-b border-[var(--color-line)] p-2">
      <Section title="Clients">
        {state.clients.length === 0 && <Empty>none yet</Empty>}
        {state.clients.map((c) => (
          <div key={c.clientId} className="flex items-baseline gap-2">
            <span style={{ color: DOT[c.status] }}>{c.alive ? '●' : '†'}</span>
            <span className="font-medium">{c.clientId}</span>
            <span className="text-[var(--color-muted)]">{c.role}</span>
            <span className="ml-auto tabular text-[var(--color-muted)]">
              {c.status === 'retrying'
                ? `retry #${c.attempt} in ${c.delayMs}ms`
                : c.status === 'closed'
                  ? `closed${c.code !== undefined ? ` ${c.code}` : ''}`
                  : c.since
                    ? duration(now - c.since)
                    : c.status}
            </span>
          </div>
        ))}
      </Section>

      <Section title={`In flight (${state.inFlight.length})`}>
        {state.inFlight.length === 0 && <Empty>nothing pending</Empty>}
        {state.inFlight.map((f) => (
          <div key={`${f.clientId}#${f.i}`} className="flex items-baseline gap-2">
            <span className="tabular text-[var(--color-muted)]">#{f.i}</span>
            <span>{f.method}</span>
            {!f.sent && <span className="text-[var(--color-warn)]">queued</span>}
            <span className="ml-auto tabular text-[var(--color-muted)]">{duration(now - f.ts)}</span>
          </div>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{title}</div>
      {children}
    </div>
  )
}

const Empty = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <div className="text-[var(--color-muted)] italic">{children}</div>
)
