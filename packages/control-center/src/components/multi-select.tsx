import * as React from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MultiSelectGroup<T extends string = string> {
  label: string
  options: { value: T; label: string }[]
}

/**
 * A compact popover multi-select. Empty selection means "all" (filter off); checking narrows.
 * Used for the type (grouped), node, and wire filters — one hand-rolled control, no new deps.
 */
export function MultiSelect<T extends string = string>({
  label,
  groups,
  selected,
  onChange,
}: {
  label: string
  groups: MultiSelectGroup<T>[]
  selected: Set<T>
  onChange: (next: Set<T>) => void
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
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          selected.size > 0 ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40',
        )}
      >
        {trigger}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div className="absolute z-20 mt-1 max-h-72 w-56 overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {groups.map((g) => {
            const grouped = groups.length > 1 || g.label !== ''
            const allOn = g.options.every((o) => selected.has(o.value))
            return (
              <div key={g.label} className="mb-1 last:mb-0">
                {grouped ? (
                  <button
                    onClick={() => toggleGroup(g)}
                    className="flex w-full items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  >
                    {g.label}
                    <span>{allOn ? 'clear' : 'all'}</span>
                  </button>
                ) : null}
                {g.options.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent/40"
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                        selected.has(o.value) && 'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {selected.has(o.value) ? <Check className="h-2.5 w-2.5" /> : null}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
