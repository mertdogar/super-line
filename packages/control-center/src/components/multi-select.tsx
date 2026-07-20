import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MultiSelectGroup<T extends string = string> {
  label: string
  options: { value: T; label: string }[]
}

/** One async page of options; `offset` is how many results are already loaded. */
export type OptionSearch<T extends string = string> = (
  query: string,
  offset: number,
) => Promise<{ value: T; label: string }[]>

/**
 * A compact popover multi-select. Empty selection means "all" (filter off); checking narrows.
 * Two modes: static `groups` (type/node/wire filters) or, when `onSearch` is given, a server-backed
 * async search (debounced box + load-more) with the current selection pinned + checked at the top.
 */
export function MultiSelect<T extends string = string>({
  label,
  groups = [],
  selected,
  onChange,
  onSearch,
  pageSize = 50,
}: {
  label: string
  groups?: MultiSelectGroup<T>[]
  selected: Set<T>
  onChange: (next: Set<T>) => void
  onSearch?: OptionSearch<T>
  pageSize?: number
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const toggle = (v: T): void => {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onChange(next)
  }
  const toggleGroup = (g: MultiSelectGroup<T>): void => {
    const allOn = g.options.every((o) => selected.has(o.value))
    const next = new Set(selected)
    for (const o of g.options) {
      if (allOn) next.delete(o.value)
      else next.add(o.value)
    }
    onChange(next)
  }

  const trigger = selected.size === 0 ? `All ${label.toLowerCase()}` : `${label}: ${selected.size}`

  return (
    <div ref={ref} className="relative">
      <button type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          selected.size > 0 ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40',
        )}
      >
        {trigger}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && onSearch ? (
        <div className="absolute z-20 mt-1 w-56 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <AsyncOptions selected={selected} toggle={toggle} onSearch={onSearch} pageSize={pageSize} />
        </div>
      ) : null}
      {open && !onSearch ? (
        <div className="absolute z-20 mt-1 max-h-72 w-56 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {groups.map((g) => {
            const grouped = groups.length > 1 || g.label !== ''
            const allOn = g.options.every((o) => selected.has(o.value))
            return (
              <div key={g.label} className="mb-1 last:mb-0">
                {grouped ? (
                  <button type="button"
                    onClick={() => toggleGroup(g)}
                    className="flex w-full items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    {g.label}
                    <span>{allOn ? 'clear' : 'all'}</span>
                  </button>
                ) : null}
                {g.options.map((o) => (
                  <OptionRow key={o.value} label={o.label} checked={selected.has(o.value)} onClick={() => toggle(o.value)} />
                ))}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function OptionRow({
  label,
  checked,
  onClick,
}: {
  label: string
  checked: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent/40"
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
          checked && 'border-primary bg-primary text-primary-foreground',
        )}
      >
        {checked ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      <span className="truncate font-mono">{label}</span>
    </button>
  )
}

/** Server-backed body: debounced search, selection pinned + checked at top, in-popover load-more. */
function AsyncOptions<T extends string>({
  selected,
  toggle,
  onSearch,
  pageSize,
}: {
  selected: Set<T>
  toggle: (v: T) => void
  onSearch: OptionSearch<T>
  pageSize: number
}): React.JSX.Element {
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<{ value: T; label: string }[]>([])
  const [more, setMore] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

  // (re)fetch page 1 on a debounced query; remounts on each open ⇒ always starts fresh
  React.useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      onSearch(query, 0)
        .then((page) => {
          if (!alive) return
          setResults(page)
          setMore(page.length === pageSize)
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, onSearch, pageSize])

  const loadMore = (): void => {
    setLoading(true)
    onSearch(query, results.length)
      .then((page) => {
        setResults((prev) => [...prev, ...page])
        setMore(page.length === pageSize)
      })
      .finally(() => setLoading(false))
  }

  // pin the current selection at the top; drop those from the result list to avoid duplicate rows
  const pinned = [...selected]
  const shown = results.filter((r) => !selected.has(r.value))

  return (
    <div className="flex flex-col">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search users…"
        className="mb-1 w-full rounded border bg-transparent px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="max-h-64 overflow-auto">
        {pinned.map((v) => (
          <OptionRow key={`sel-${v}`} label={v} checked onClick={() => toggle(v)} />
        ))}
        {pinned.length > 0 && shown.length > 0 ? <div className="my-1 border-t" /> : null}
        {shown.map((o) => (
          <OptionRow key={o.value} label={o.label} checked={false} onClick={() => toggle(o.value)} />
        ))}
        {!loading && pinned.length === 0 && shown.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No users.</p>
        ) : null}
        {more ? (
          <button type="button"
            onClick={loadMore}
            disabled={loading}
            className="w-full rounded px-2 py-1 text-center text-[11px] text-muted-foreground hover:bg-accent/40 disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
