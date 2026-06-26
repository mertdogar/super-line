import * as React from 'react'

/**
 * A magnitude bar for the size/latency columns: an always-on muted track, a fill whose width is the
 * value's fraction of the in-view max and whose color is the absolute-magnitude heatmap, and the
 * formatted value beside it. Length compares within the view; color flags absolute severity.
 */
export function MiniBar({
  fraction,
  color,
  label,
}: {
  fraction: number
  color: string
  label: string
}): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-secondary">
        <span className="block h-full rounded-full" style={{ width: `${fraction * 100}%`, background: color }} />
      </span>
      <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{label}</span>
    </span>
  )
}
