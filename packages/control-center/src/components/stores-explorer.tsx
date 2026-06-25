import * as React from 'react'
import type { InspectorEvent, StoreInfo, StoreResourceView } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { Badge } from '@/components/ui/badge'
import { Json } from '@/components/json-view'
import { cn } from '@/lib/utils'

export function StoresExplorer({ client }: { client: InspectorClient | null }): React.JSX.Element {
  const [stores, setStores] = React.useState<StoreInfo[]>([])
  const [store, setStore] = React.useState<string | null>(null)
  const [resources, setResources] = React.useState<string[]>([])
  const [id, setId] = React.useState<string | null>(null)
  const [view, setView] = React.useState<StoreResourceView | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // store and id held in refs so the live-event handler can compare without re-subscribing
  const sel = React.useRef({ store, id })
  sel.current = { store, id }

  React.useEffect(() => {
    if (!client) return
    client.listStores().then(setStores).catch(() => {})
  }, [client])

  const loadResources = React.useCallback(
    (s: string) => {
      client?.listResources(s).then(setResources).catch(() => {})
    },
    [client],
  )

  const loadValue = React.useCallback(
    (s: string, rid: string) => {
      client
        ?.readResource(s, rid)
        .then((v) => {
          setView(v)
          setError(null)
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
    [client],
  )

  React.useEffect(() => {
    if (store) loadResources(store)
  }, [store, loadResources])

  React.useEffect(() => {
    if (store && id) loadValue(store, id)
  }, [store, id, loadValue])

  React.useEffect(() => {
    if (!client) return
    return client.onEvent((e: InspectorEvent) => {
      if (!('store' in e) || e.store !== sel.current.store) return
      if (e.type === 'store.create' || e.type === 'store.delete') loadResources(e.store)
      else if ('id' in e && e.id === sel.current.id) loadValue(e.store, e.id)
    })
  }, [client, loadResources, loadValue])

  return (
    <div className="flex h-full gap-3">
      <Column title="Stores">
        {stores.map((s) => (
          <Row key={s.name} active={s.name === store} onClick={() => { setStore(s.name); setId(null); setView(null) }}>
            <span className="truncate">{s.name}</span>
            {s.model ? <Badge variant="muted" className="ml-auto uppercase">{s.model}</Badge> : null}
          </Row>
        ))}
        {stores.length === 0 && <Empty>No stores configured.</Empty>}
      </Column>

      <Column title="Resources">
        {store == null ? (
          <Empty>Select a store.</Empty>
        ) : resources.length === 0 ? (
          <Empty>No resources.</Empty>
        ) : (
          resources.map((rid) => (
            <Row key={rid} active={rid === id} onClick={() => setId(rid)}>
              <span className="truncate font-mono text-xs">{rid}</span>
            </Row>
          ))
        )}
      </Column>

      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto">
        {id == null ? (
          <Empty>Select a resource.</Empty>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : view ? (
          <>
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Value</h3>
              <Json data={view.data} />
            </section>
            <section>
              <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Access rules</h3>
              <Json data={view.accessRules} />
            </section>
          </>
        ) : (
          <Empty>Loading…</Empty>
        )}
      </div>
    </div>
  )
}

function Column({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex w-56 shrink-0 flex-col rounded-md border bg-card/40">
      <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">{title}</div>
      <div className="flex flex-col gap-0.5 overflow-auto p-1">{children}</div>
    </div>
  )
}

function Row({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
      )}
    >
      {children}
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="p-3 text-sm text-muted-foreground">{children}</p>
}
