import { Cable } from 'lucide-react'
import { kind, switchTransport, TRANSPORT_LABELS, type TransportKind } from '@/lib/transport'
import { cn } from '@/lib/utils'

const KINDS = Object.keys(TRANSPORT_LABELS) as TransportKind[]

/**
 * The dial. Picking a wire reloads the tab with `?transport=…`; the access token is in localStorage,
 * so you come back signed in, in the same channel, with the same history — over a different wire.
 */
export function TransportDial({ tone = 'sidebar' }: { tone?: 'sidebar' | 'light' }): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex items-center gap-2 text-xs',
        tone === 'sidebar' ? 'text-sidebar-muted' : 'text-muted-foreground',
      )}
    >
      <Cable className="h-3.5 w-3.5 shrink-0" />
      <span className="font-semibold uppercase tracking-wide">Wire</span>
      <select
        value={kind}
        onChange={(e) => switchTransport(e.target.value as TransportKind)}
        className={cn(
          'ml-auto rounded border px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring',
          tone === 'sidebar'
            ? 'border-sidebar-border bg-sidebar-accent text-sidebar-foreground'
            : 'border-input bg-background text-foreground',
        )}
      >
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {TRANSPORT_LABELS[k]}
          </option>
        ))}
      </select>
    </label>
  )
}
