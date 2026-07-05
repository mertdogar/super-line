import * as React from 'react'
import { ArrowRight, KeyRound, RefreshCw } from 'lucide-react'
import type { CollectionInfo } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { Badge } from '@/components/ui/badge'
import { Json } from '@/components/json-view'
import { cn } from '@/lib/utils'

const PAGE = 100
type Row = Record<string, unknown>

/** Field names + types pulled best-effort from a collection's JSON Schema (omitted when no converter is available). */
function fieldsOf(schema: unknown): { name: string; type: string }[] {
  const props = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties
  if (!props || typeof props !== 'object') return []
  return Object.entries(props).map(([name, def]) => ({ name, type: typeof def?.type === 'string' ? def.type : '' }))
}

export function CollectionsExplorer({ client }: { client: InspectorClient | null }): React.JSX.Element {
  const [collections, setCollections] = React.useState<CollectionInfo[]>([])
  const [name, setName] = React.useState<string | null>(null)
  const [rows, setRows] = React.useState<Row[]>([])
  const [more, setMore] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [selected, setSelected] = React.useState<Row | null>(null)

  const rowsRef = React.useRef<Row[]>([])
  rowsRef.current = rows
  const selectedCollection = collections.find((c) => c.name === name) ?? null

  React.useEffect(() => {
    if (!client) return
    client.listCollections().then(setCollections).catch(() => {})
  }, [client])

  const load = React.useCallback(
    (reset: boolean) => {
      if (!client || !name) return
      const col = collections.find((c) => c.name === name)
      const key = col?.key ?? 'id'
      setLoading(true)
      client
        .queryCollection(name, { orderBy: [{ field: key, dir: 'asc' }], limit: PAGE, offset: reset ? 0 : rowsRef.current.length })
        .then((page) => {
          const next = page as Row[]
          setRows(reset ? next : [...rowsRef.current, ...next])
          setMore(next.length === PAGE)
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [client, name, collections],
  )

  React.useEffect(() => load(true), [load])

  const pick = (n: string): void => {
    setName(n)
    setRows([])
    setFilter('')
    setSelected(null)
  }

  const key = selectedCollection?.key ?? 'id'
  const idOf = (r: Row): string => String(r[key] ?? '')
  const shown = filter ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(filter.toLowerCase())) : rows

  return (
    <div className="flex h-full gap-3">
      <div className="flex w-56 shrink-0 flex-col rounded-md border bg-card/40">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">Collections</div>
        <div className="flex flex-col gap-0.5 overflow-auto p-1">
          {collections.map((c) => (
            <button
              key={c.name}
              onClick={() => pick(c.name)}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                c.name === name ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <span className="truncate">{c.name}</span>
              {Object.keys(c.references).length > 0 ? (
                <Badge variant="muted" className="ml-auto">
                  {Object.keys(c.references).length} fk
                </Badge>
              ) : null}
            </button>
          ))}
          {collections.length === 0 && <p className="p-3 text-sm text-muted-foreground">No collections declared.</p>}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        {selectedCollection == null ? (
          <p className="p-3 text-sm text-muted-foreground">Select a collection.</p>
        ) : (
          <>
            {/* Schema panel: fields + primary key + the advisory foreign-key edges */}
            <div className="shrink-0 rounded-md border bg-card/40 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {fieldsOf(selectedCollection.schema).length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    key <span className="font-mono text-foreground">{selectedCollection.key}</span> · schema unavailable
                  </span>
                ) : (
                  fieldsOf(selectedCollection.schema).map((f) => (
                    <span
                      key={f.name}
                      className={cn(
                        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px]',
                        f.name === selectedCollection.key && 'border-amber-400/40 bg-amber-400/10 text-amber-300',
                      )}
                    >
                      {f.name === selectedCollection.key ? <KeyRound className="h-3 w-3" /> : null}
                      {f.name}
                      {f.type ? <span className="text-muted-foreground">:{f.type}</span> : null}
                    </span>
                  ))
                )}
              </div>
              {Object.entries(selectedCollection.references).map(([field, refCollection]) => (
                <div key={field} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="font-mono text-foreground">{field}</span>
                  <ArrowRight className="h-3 w-3" />
                  <button
                    onClick={() => pick(refCollection)}
                    className="font-mono text-sky-300 underline-offset-2 hover:underline"
                  >
                    {refCollection}
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter rows…"
                className="w-48 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={() => load(true)}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40"
              >
                <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
                Refresh
              </button>
              <span className="text-xs text-muted-foreground">{shown.length} rows</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-card/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{key}</th>
                    <th className="px-3 py-2 font-medium">row</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={idOf(r)}
                      onClick={() => setSelected(r)}
                      className={cn('cursor-pointer border-b last:border-0 hover:bg-accent/40', selected != null && idOf(selected) === idOf(r) && 'bg-accent/60')}
                    >
                      <td className="px-3 py-1.5 font-mono text-xs">
                        <span className="block max-w-[16rem] truncate">{idOf(r)}</span>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        <span className="block max-w-[38rem] truncate font-mono">{JSON.stringify(r)}</span>
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={2} className="px-3 py-3 text-sm text-muted-foreground">
                        {filter ? 'No rows match the filter.' : 'No rows.'}
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

            {selected != null ? (
              <div className="max-h-[42%] shrink-0 overflow-auto rounded-md border bg-card/40 p-3">
                <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
                  Row <span className="font-mono font-normal">· {idOf(selected)}</span>
                </h3>
                <Json data={selected} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
