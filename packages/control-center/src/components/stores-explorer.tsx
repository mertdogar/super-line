import * as React from 'react'
import { Zap } from 'lucide-react'
import type { ListOpts, ResourceSummary, StoreInfo, StoreResourceView } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { Badge } from '@/components/ui/badge'
import { Json } from '@/components/json-view'
import { MultiSelect, type OptionSearch } from '@/components/multi-select'
import { formatDuration, formatTime } from '@/lib/events'
import { cn } from '@/lib/utils'

const PAGE = 50
type Sort = NonNullable<ListOpts['sort']>
const DEFAULT_SORT: Sort = { by: 'updatedAt', dir: 'desc' }

export function StoresExplorer({ client }: { client: InspectorClient | null }): React.JSX.Element {
  const [stores, setStores] = React.useState<StoreInfo[]>([])
  const [store, setStore] = React.useState<string | null>(null)

  // filters: `idInput` is what the user types; `idContains` is its debounced, query-driving copy
  const [idInput, setIdInput] = React.useState('')
  const [idContains, setIdContains] = React.useState('')
  const [principals, setPrincipals] = React.useState<Set<string>>(new Set())
  const [sort, setSort] = React.useState<Sort>(DEFAULT_SORT)

  const [rows, setRows] = React.useState<ResourceSummary[]>([])
  const [more, setMore] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [pending, setPending] = React.useState(0) // live create/deletes since last load → refresh pill

  const [id, setId] = React.useState<string | null>(null)
  const [view, setView] = React.useState<StoreResourceView | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  // store/id in a ref so the live-event handler compares without re-subscribing; rows for load-more offset
  const sel = React.useRef({ store, id })
  sel.current = { store, id }
  const rowsRef = React.useRef<ResourceSummary[]>([])
  rowsRef.current = rows

  React.useEffect(() => {
    if (!client) return
    client.listStores().then(setStores).catch(() => {})
  }, [client])

  // debounce the id filter so a keystroke doesn't hit the server on every character
  React.useEffect(() => {
    const t = setTimeout(() => setIdContains(idInput.trim()), 250)
    return () => clearTimeout(t)
  }, [idInput])

  const load = React.useCallback(
    (reset: boolean) => {
      if (!client || !store) return
      setLoading(true)
      const opts: ListOpts = {
        idContains: idContains || undefined,
        principals: principals.size ? [...principals] : undefined,
        sort,
        limit: PAGE,
        offset: reset ? 0 : rowsRef.current.length,
      }
      client
        .listResources(store, opts)
        .then((page) => {
          setRows(reset ? page : [...rowsRef.current, ...page])
          setMore(page.length === PAGE)
          if (reset) setPending(0)
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [client, store, idContains, principals, sort],
  )

  // reload the first page whenever the store, filters, or sort change
  React.useEffect(() => load(true), [load])

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
    if (store && id) loadValue(store, id)
  }, [store, id, loadValue])

  // live: create/delete bumps the refresh pill (list is server-paginated, don't silently reshuffle it);
  // a change to the selected resource refreshes the detail in place.
  React.useEffect(() => {
    if (!client) return
    return client.onEvent(({ event: e }) => {
      if (!('store' in e) || e.store !== sel.current.store) return
      if (e.type === 'store.create' || e.type === 'store.delete') setPending((n) => n + 1)
      else if ('id' in e && e.id === sel.current.id) loadValue(e.store, e.id)
    })
  }, [client, loadValue])

  const pickStore = (name: string): void => {
    setStore(name)
    setIdInput('')
    setIdContains('')
    setPrincipals(new Set())
    setSort(DEFAULT_SORT)
    setId(null)
    setView(null)
    setError(null)
  }

  const onSort = (by: Sort['by']): void =>
    setSort((prev) => (prev.by === by ? { by, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { by, dir: by === 'id' ? 'asc' : 'desc' }))

  const searchUsers = React.useCallback<OptionSearch>(
    (query, offset) => {
      if (!client || !store) return Promise.resolve([])
      return client
        .searchPrincipals(store, { query: query || undefined, limit: PAGE, offset })
        .then((ps) => ps.map((p) => ({ value: p, label: p })))
        .catch(() => [])
    },
    [client, store],
  )

  const filtersActive = idInput !== '' || principals.size > 0

  return (
    <div className="flex h-full gap-3">
      <Column title="Stores">
        {stores.map((s) => (
          <Row key={s.name} active={s.name === store} onClick={() => pickStore(s.name)}>
            <span className="truncate">{s.name}</span>
            {s.model ? <Badge variant="muted" className="ml-auto uppercase">{s.model}</Badge> : null}
          </Row>
        ))}
        {stores.length === 0 && <Empty>No stores configured.</Empty>}
      </Column>

      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        {store == null ? (
          <Empty>Select a store.</Empty>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={idInput}
                onChange={(e) => setIdInput(e.target.value)}
                placeholder="Filter by id…"
                className="w-40 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <MultiSelect label="Users" selected={principals} onChange={setPrincipals} onSearch={searchUsers} pageSize={PAGE} />
              {filtersActive ? (
                <button
                  onClick={() => {
                    setIdInput('')
                    setIdContains('')
                    setPrincipals(new Set())
                  }}
                  className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
                >
                  Reset
                </button>
              ) : null}
              {pending > 0 ? (
                <button
                  onClick={() => load(true)}
                  className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/15 px-2 py-1 text-xs text-amber-300 hover:bg-amber-400/25"
                >
                  <Zap className="h-3 w-3" />
                  {pending} {pending === 1 ? 'change' : 'changes'} · refresh
                </button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-card/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <SortTh by="id" label="id" sort={sort} onSort={onSort} />
                    <SortTh by="principalCount" label="users" sort={sort} onSort={onSort} align="right" />
                    <SortTh by="createdAt" label="created" sort={sort} onSort={onSort} />
                    <SortTh by="updatedAt" label="updated" sort={sort} onSort={onSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setId(r.id)}
                      className={cn(
                        'cursor-pointer border-b last:border-0 hover:bg-accent/40',
                        r.id === id && 'bg-accent/60',
                      )}
                    >
                      <td className="px-3 py-1.5 font-mono text-xs">
                        <span className="block max-w-[22rem] truncate">{r.id}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-xs text-muted-foreground">{r.principalCount}</td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                        {formatTime(r.createdAt)} <span className="opacity-60">· {formatDuration(r.createdAt)}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                        {formatTime(r.updatedAt)} <span className="opacity-60">· {formatDuration(r.updatedAt)}</span>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-sm text-muted-foreground">
                        {filtersActive ? 'No resources match the filter.' : 'No resources.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {more ? (
                <button
                  onClick={() => load(false)}
                  disabled={loading}
                  className="w-full border-t px-3 py-1.5 text-center text-xs text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </div>

            {id != null ? (
              <div className="max-h-[42%] shrink-0 overflow-auto rounded-md border bg-card/40 p-3">
                {error ? (
                  <p className="text-sm text-destructive">{error}</p>
                ) : view ? (
                  <div className="flex flex-col gap-3">
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
                        Value <span className="font-mono font-normal">· {id}</span>
                      </h3>
                      <Json data={view.data} />
                    </section>
                    <section>
                      <h3 className="mb-1 text-xs font-semibold text-muted-foreground">Access rules</h3>
                      <Json data={view.accessRules} />
                    </section>
                  </div>
                ) : (
                  <Empty>Loading…</Empty>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function SortTh({
  by,
  label,
  sort,
  onSort,
  align = 'left',
}: {
  by: Sort['by']
  label: string
  sort: Sort
  onSort: (by: Sort['by']) => void
  align?: 'left' | 'right'
}): React.JSX.Element {
  const active = sort.by === by
  return (
    <th
      onClick={() => onSort(by)}
      className={cn('cursor-pointer select-none px-3 py-2 font-medium hover:text-foreground', align === 'right' && 'text-right')}
    >
      {label}
      {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
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
