import * as React from 'react'
import type { ConnView } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { formatDuration, formatTime } from '@/lib/events'
import { transportLabel } from '@/lib/transport'
import { shortId, type Directory, type Identity } from '@/lib/identity'
import { Json } from '@/components/json-view'
import { Button } from '@/components/ui/button'

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

/**
 * The auth directory row behind this connection. Sourced from the directory rather than `ctx`, so it is
 * present for connections on other nodes too — `ctx` is node-local.
 */
function UserSection({ identity }: { identity: Identity }): React.JSX.Element {
  return (
    <Section title="user · auth directory">
      <div className="rounded-md border bg-card/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{identity.displayName ?? shortId(identity.userId)}</span>
          {identity.deletedAt ? (
            <span className="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive">
              deactivated {formatTime(identity.deletedAt)}
            </span>
          ) : null}
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">{identity.userId}</div>
        {identity.roles?.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {identity.roles.map((r) => (
              <span key={r} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">
                {r}
              </span>
            ))}
          </div>
        ) : null}
        {identity.createdAt ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            created {formatTime(identity.createdAt)} · {formatDuration(identity.createdAt)} ago
          </div>
        ) : null}
      </div>
      {identity.metadata && Object.keys(identity.metadata).length > 0 ? (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">metadata</div>
          <Json data={identity.metadata} className="max-h-72" />
        </div>
      ) : null}
    </Section>
  )
}

export function ConnDetail({
  client,
  connId,
  directory,
  onClose,
}: {
  client: InspectorClient | null
  connId: string | null
  directory: Directory
  onClose: () => void
}): React.JSX.Element | null {
  const [view, setView] = React.useState<ConnView | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!client || !connId) return
    let live = true
    setView(null)
    setError(null)
    client
      .getConn(connId)
      .then((v) => {
        if (live) setView(v)
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [client, connId])

  if (!connId) return null
  const identity = view?.descriptor.userId ? directory.get(view.descriptor.userId) : undefined

  return (
    <div className="absolute inset-0 z-10 flex">
      <button type="button" className="flex-1 bg-black/40" onClick={onClose} aria-label="Close detail" />
      <div className="w-104 overflow-auto border-l bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            {identity?.displayName ? (
              <div className="truncate text-sm font-semibold">{identity.displayName}</div>
            ) : null}
            <h3 className={identity?.displayName ? 'text-xs text-muted-foreground' : 'text-sm font-semibold'}>
              Connection {connId.slice(0, 8)}
            </h3>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            close
          </Button>
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        {view ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              {view.descriptor.nodeName} · over {transportLabel(view.descriptor.transport)} · connected{' '}
              {formatTime(view.descriptor.connectedAt)} · {formatDuration(view.descriptor.connectedAt)} ago
            </p>
            {identity ? <UserSection identity={identity} /> : null}
            <Section title="descriptor">
              <Json data={view.descriptor} className="max-h-72" />
            </Section>
            {view.ctxAvailable ? (
              <>
                <Section title="ctx · node-local, best-effort">
                  <Json data={view.ctx} className="max-h-72" />
                </Section>
                <Section title="conn.data">
                  <Json data={view.data} className="max-h-72" />
                </Section>
                {view.env !== undefined && view.env !== null ? (
                  <Section title="conn.env · masked — values hidden unless revealEnvKeys-allowed">
                    <Json data={view.env} className="max-h-72" />
                  </Section>
                ) : null}
              </>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                ctx / conn.data live on node {view.descriptor.nodeId.slice(0, 8)} — point the Control
                Center at that node to inspect them.
              </p>
            )}
          </>
        ) : error ? null : (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  )
}
