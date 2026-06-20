import * as React from 'react'
import type { ConnView } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
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

export function ConnDetail({
  client,
  connId,
  onClose,
}: {
  client: InspectorClient | null
  connId: string | null
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

  return (
    <div className="absolute inset-0 z-10 flex">
      <button className="flex-1 bg-black/40" onClick={onClose} aria-label="Close detail" />
      <div className="w-[26rem] overflow-auto border-l bg-card p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Connection {connId.slice(0, 8)}</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            close
          </Button>
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        {view ? (
          <>
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
