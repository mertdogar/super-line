import * as React from 'react'
import { ArrowDown, ArrowRight, ArrowUp, KeyRound, Plus, RefreshCw, X } from 'lucide-react'
import { andFilters, eq, gt, gte, ilike, lt, lte, neq, ROW_CREATED_AT, ROW_UPDATED_AT } from '@super-line/core'
import type { CollectionInfo, Expr, Scalar } from '@super-line/core'
import type { InspectorClient } from '@/lib/inspector-client'
import { Badge } from '@/components/ui/badge'
import { Json } from '@/components/json-view'
import { formatDuration, formatTime } from '@/lib/events'
import { clickable, cn } from '@/lib/utils'

const PAGE = 100
type Row = Record<string, unknown>
type Op = 'eq' | 'neq' | 'contains' | 'lt' | 'lte' | 'gt' | 'gte' | 'is' | 'after' | 'before' | 'within'
type Field = { name: string; type: string; label?: string }
type Condition = { id: number; field: string; op: Op; value: string; unit?: TimeUnit }
type SortState = { field: string; dir: 'asc' | 'desc' }
type TimeUnit = 'm' | 'h' | 'd'

const UNIT_MS: Record<TimeUnit, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const OP_LABEL: Record<Op, string> = { eq: '=', neq: '≠', contains: 'contains', lt: '<', lte: '≤', gt: '>', gte: '≥', is: 'is', after: 'after', before: 'before', within: 'within last' }

/** The operators offered for a field, by its JSON-Schema type (empty type = schema unavailable → all comparisons). */
function opsFor(type: string): Op[] {
  if (type === 'datetime') return ['after', 'before', 'within']
  if (type === 'boolean') return ['is']
  if (type === 'number' || type === 'integer') return ['eq', 'neq', 'lt', 'lte', 'gt', 'gte']
  if (type === 'string') return ['eq', 'neq', 'contains']
  return ['eq', 'neq', 'contains', 'lt', 'lte', 'gt', 'gte']
}

/** Coerce a text value to the scalar the filter needs — by declared type, or a numeric-looking heuristic when the schema is unknown. */
function coerceVal(v: string, type: string, op: Op): Scalar {
  if (op === 'is' || type === 'boolean') return v === 'true'
  if (type === 'number' || type === 'integer') return Number(v)
  if (op === 'contains') return v
  if (type !== 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return v
}

function condToExpr(c: Condition, type: string, now: number): Expr | undefined {
  if (c.op !== 'is' && c.value.trim() === '') return undefined // an empty value is "not set", not a filter
  if (type === 'datetime') {
    if (c.op === 'within') return gte(c.field, now - Number(c.value) * UNIT_MS[c.unit ?? 'h']) // last N units
    const ms = new Date(c.value).getTime() // datetime-local → epoch ms
    if (Number.isNaN(ms)) return undefined
    return c.op === 'after' ? gt(c.field, ms) : lt(c.field, ms)
  }
  const v = coerceVal(c.value, type, c.op)
  switch (c.op) {
    case 'eq':
    case 'is':
      return eq(c.field, v)
    case 'neq':
      return neq(c.field, v)
    case 'contains':
      return ilike(c.field, `%${c.value}%`)
    case 'lt':
      return lt(c.field, v)
    case 'lte':
      return lte(c.field, v)
    case 'gt':
      return gt(c.field, v)
    case 'gte':
      return gte(c.field, v)
    default:
      return undefined
  }
}

/** The reserved created/updated timestamp (epoch ms) the inspector merges onto a row, or null if absent. */
function tsOf(r: Row, key: string): number | null {
  const v = r[key]
  return typeof v === 'number' ? v : null
}

/** Field names + types pulled best-effort from a collection's JSON Schema (omitted when no converter is available). */
function fieldsOf(schema: unknown): Field[] {
  const props = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties
  if (!props || typeof props !== 'object') return []
  return Object.entries(props).map(([name, def]) => ({ name, type: typeof def?.type === 'string' ? def.type : '' }))
}

/** One `field op value` row of the structured filter. Fields become a select when the schema is known, a text input otherwise. */
function FilterRow({ cond, fields, schemaLess, onChange, onRemove }: { cond: Condition; fields: Field[]; schemaLess: boolean; onChange: (c: Condition) => void; onRemove: () => void }): React.JSX.Element {
  const type = fields.find((f) => f.name === cond.field)?.type ?? ''
  const ops = opsFor(type)
  const inputCls = 'rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring'
  const listId = `flt-${cond.id}`
  return (
    <div className="flex items-center gap-1.5">
      {!schemaLess ? (
        <select
          aria-label="Filter field"
          value={cond.field}
          onChange={(e) => {
            const t = fields.find((f) => f.name === e.target.value)?.type ?? ''
            const op = opsFor(t)[0]! // reset op to one valid for the new field's type; clear value (types differ)
            onChange({ ...cond, field: e.target.value, op, value: op === 'is' ? 'true' : '', unit: 'h' })
          }}
          className={cn(inputCls, 'font-mono')}
        >
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.label ?? f.name}
            </option>
          ))}
        </select>
      ) : (
        <>
          <input
            aria-label="Filter field"
            value={cond.field}
            list={listId}
            onChange={(e) => {
              const t = fields.find((f) => f.name === e.target.value)?.type ?? ''
              onChange({ ...cond, field: e.target.value, op: opsFor(t)[0]! })
            }}
            placeholder="field"
            className={cn(inputCls, 'w-32 font-mono')}
          />
          <datalist id={listId}>
            {fields.map((f) => (
              <option key={f.name} value={f.name} />
            ))}
          </datalist>
        </>
      )}
      <select
        aria-label="Filter operator"
        value={cond.op}
        onChange={(e) => {
          const op = e.target.value as Op
          onChange({ ...cond, op, value: (op === 'within') !== (cond.op === 'within') ? '' : cond.value }) // value shape changes across "within"
        }}
        className={inputCls}
      >
        {ops.map((o) => (
          <option key={o} value={o}>
            {OP_LABEL[o]}
          </option>
        ))}
      </select>
      {type === 'boolean' || cond.op === 'is' ? (
        <select aria-label="Filter value" value={cond.value || 'true'} onChange={(e) => onChange({ ...cond, value: e.target.value })} className={inputCls}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : type === 'datetime' && cond.op === 'within' ? (
        <>
          <input type="number" min="1" value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })} placeholder="N" className={cn(inputCls, 'w-16')} />
          <select aria-label="Filter time unit" value={cond.unit ?? 'h'} onChange={(e) => onChange({ ...cond, unit: e.target.value as TimeUnit })} className={inputCls}>
            <option value="m">minutes</option>
            <option value="h">hours</option>
            <option value="d">days</option>
          </select>
        </>
      ) : type === 'datetime' ? (
        <input aria-label="Filter value" type="datetime-local" value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })} className={cn(inputCls, 'w-52')} />
      ) : (
        <input value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })} placeholder="value" className={cn(inputCls, 'w-40')} />
      )}
      <button type="button" onClick={onRemove} className="rounded p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground" title="Remove condition">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export function CollectionsExplorer({ client }: { client: InspectorClient | null }): React.JSX.Element {
  const [collections, setCollections] = React.useState<CollectionInfo[]>([])
  const [name, setName] = React.useState<string | null>(null)
  const [rows, setRows] = React.useState<Row[]>([])
  const [more, setMore] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [text, setText] = React.useState('') // client-side quick substring over loaded rows
  const [conditions, setConditions] = React.useState<Condition[]>([]) // structured server-side filter (row collections)
  const [idFilter, setIdFilter] = React.useState('') // server-side id-substring filter (CRDT collections)
  const [sort, setSort] = React.useState<SortState>({ field: 'id', dir: 'asc' })
  const [selected, setSelected] = React.useState<Row | null>(null)

  const rowsRef = React.useRef<Row[]>([])
  React.useEffect(() => {
    rowsRef.current = rows
  })
  const condId = React.useRef(0)
  const selectedCollection = collections.find((c) => c.name === name) ?? null
  const isCrdt = selectedCollection?.crdt ?? false
  const schemaFields = React.useMemo(() => fieldsOf(selectedCollection?.schema), [selectedCollection])
  // Filterable fields = schema fields + the inspector-only created/updated timestamps (datetime).
  const filterFields = React.useMemo<Field[]>(
    () => [...schemaFields, { name: ROW_CREATED_AT, type: 'datetime', label: 'created' }, { name: ROW_UPDATED_AT, type: 'datetime', label: 'updated' }],
    [schemaFields],
  )

  React.useEffect(() => {
    if (!client) return
    client.listCollections().then(setCollections).catch(() => {})
  }, [client])

  // Build the server-side filter IR from the current UI: id-substring for CRDT, ANDed field conditions for rows.
  const buildFilter = React.useCallback((): Expr | undefined => {
    if (isCrdt) return idFilter.trim() ? ilike('id', `%${idFilter}%`) : undefined
    const now = Date.now() // anchors "within last N" at query-build time
    const exprs = conditions.map((c) => condToExpr(c, filterFields.find((f) => f.name === c.field)?.type ?? '', now)).filter((e): e is Expr => e !== undefined)
    return andFilters(...exprs)
  }, [isCrdt, idFilter, conditions, filterFields])

  const load = React.useCallback(
    (reset: boolean) => {
      if (!client || !name) return
      setLoading(true)
      client
        .queryCollection(name, { filter: buildFilter(), orderBy: [{ field: sort.field, dir: sort.dir }], limit: PAGE, offset: reset ? 0 : rowsRef.current.length })
        .then((page) => {
          const next = page as Row[]
          setRows(reset ? next : [...rowsRef.current, ...next])
          setMore(next.length === PAGE)
        })
        .catch(() => {})
        .finally(() => setLoading(false))
    },
    [client, name, buildFilter, sort],
  )

  // Reload on collection / filter / sort change, debounced so typing a filter value doesn't fire a query per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => load(true), 200)
    return () => clearTimeout(t)
  }, [load])

  const pick = (n: string): void => {
    const col = collections.find((c) => c.name === n)
    setName(n)
    setRows([])
    setText('')
    setConditions([])
    setIdFilter('')
    setSelected(null)
    setSort({ field: col?.key ?? 'id', dir: 'asc' })
  }

  const addCondition = (): void => {
    const f = schemaFields[0] // default to the first schema field (created/updated are opt-in via the dropdown)
    const op = opsFor(f?.type ?? '')[0]!
    const id = ++condId.current
    setConditions((cs) => [...cs, { id, field: f?.name ?? '', op, value: op === 'is' ? 'true' : '', unit: 'h' }])
  }
  const setCondition = (c: Condition): void => setConditions((cs) => cs.map((x) => (x.id === c.id ? c : x)))
  const removeCondition = (id: number): void => setConditions((cs) => cs.filter((x) => x.id !== id))
  const toggleSort = (field: string): void => setSort((s) => (s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' }))

  const key = selectedCollection?.key ?? 'id'
  const idOf = (r: Row): string => String(r[key] ?? '')
  const shown = text ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(text.toLowerCase())) : rows

  const sortArrow = (field: string): React.JSX.Element | null =>
    sort.field !== field ? null : sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
  const SortTh = ({ field, label }: { field: string; label: string }): React.JSX.Element => (
    <th className="px-3 py-2 font-medium">
      <button type="button" onClick={() => toggleSort(field)} className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground">
        {label}
        {sortArrow(field)}
      </button>
    </th>
  )

  return (
    <div className="flex h-full gap-3">
      <div className="flex w-56 shrink-0 flex-col rounded-md border bg-card/40">
        <div className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">Collections</div>
        <div className="flex flex-col gap-0.5 overflow-auto p-1">
          {collections.map((c) => (
            <button type="button"
              key={c.name}
              onClick={() => pick(c.name)}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                c.name === name ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              <span className="truncate">{c.name}</span>
              {c.crdt ? (
                <Badge variant="muted" className="ml-auto">
                  crdt
                </Badge>
              ) : Object.keys(c.references).length > 0 ? (
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
                {schemaFields.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    key <span className="font-mono text-foreground">{selectedCollection.key}</span> · schema unavailable
                  </span>
                ) : (
                  schemaFields.map((f) => (
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
                  <button type="button" onClick={() => pick(refCollection)} className="font-mono text-sky-300 underline-offset-2 hover:underline">
                    {refCollection}
                  </button>
                </div>
              ))}
            </div>

            {/* Structured, server-side filter: ANDed field conditions for rows; id-substring for CRDT docs */}
            <div className="flex flex-col gap-1.5">
              {isCrdt ? (
                <input
                  value={idFilter}
                  onChange={(e) => setIdFilter(e.target.value)}
                  placeholder="id contains…"
                  className="w-64 rounded-md border bg-transparent px-2 py-1 text-xs font-mono outline-none focus:ring-1 focus:ring-ring"
                />
              ) : (
                conditions.map((c) => (
                  <FilterRow key={c.id} cond={c} fields={filterFields} schemaLess={schemaFields.length === 0} onChange={setCondition} onRemove={() => removeCondition(c.id)} />
                ))
              )}
              <div className="flex flex-wrap items-center gap-1.5">
                {!isCrdt ? (
                  <button type="button" onClick={addCondition} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40">
                    <Plus className="h-3 w-3" />
                    Add filter
                  </button>
                ) : null}
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Quick find (loaded rows)…"
                  className="w-48 rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <button type="button" onClick={() => load(true)} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40">
                  <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
                  Refresh
                </button>
                <span className="text-xs text-muted-foreground">{shown.length} rows</span>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-card/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                    <SortTh field={key} label={key} />
                    <SortTh field={ROW_CREATED_AT} label="created" />
                    <SortTh field={ROW_UPDATED_AT} label="updated" />
                    <th className="px-3 py-2 font-medium">row</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={idOf(r)}
                      {...clickable(() => setSelected(r))}
                      className={cn('cursor-pointer border-b last:border-0 hover:bg-accent/40', selected != null && idOf(selected) === idOf(r) && 'bg-accent/60')}
                    >
                      <td className="px-3 py-1.5 font-mono text-xs">
                        <span className="block max-w-[16rem] truncate">{idOf(r)}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground" title={tsOf(r, ROW_CREATED_AT) != null ? formatTime(tsOf(r, ROW_CREATED_AT)!) : undefined}>
                        {tsOf(r, ROW_CREATED_AT) != null ? `${formatDuration(tsOf(r, ROW_CREATED_AT)!)} ago` : '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground" title={tsOf(r, ROW_UPDATED_AT) != null ? formatTime(tsOf(r, ROW_UPDATED_AT)!) : undefined}>
                        {tsOf(r, ROW_UPDATED_AT) != null ? `${formatDuration(tsOf(r, ROW_UPDATED_AT)!)} ago` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        <span className="block max-w-[38rem] truncate font-mono">{JSON.stringify(r)}</span>
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && !loading ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-sm text-muted-foreground">
                        {text || conditions.length > 0 || idFilter ? 'No rows match the filter.' : 'No rows.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {more ? (
                <button type="button"
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
