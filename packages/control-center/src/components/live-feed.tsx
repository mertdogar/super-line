import * as React from 'react'
import { ChevronRight, Pause, Play } from 'lucide-react'
import type { ConnDescriptor, InspectorEvent } from '@super-line/core'
import {
  eventCategory,
  eventColor,
  eventPayload,
  summarizeEvent,
  type FeedCategory,
  type FeedResolver,
} from '@/lib/events'
import { Json } from '@/components/json-view'
import { cn } from '@/lib/utils'

const CATEGORIES: { id: FeedCategory; label: string }[] = [
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'requests', label: 'Requests' },
  { id: 'events', label: 'Events' },
]

function FeedRow({ event, resolver }: { event: InspectorEvent; resolver: FeedResolver }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const payload = eventPayload(event)
  const hasPayload = payload !== undefined

  return (
    <li className="rounded-md border">
      <button
        type="button"
        disabled={!hasPayload}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm',
          hasPayload && 'cursor-pointer hover:bg-accent/40',
        )}
      >
        <span className={cn('h-2 w-2 shrink-0 rounded-full', eventColor(event.type))} />
        <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{event.type}</span>
        <span className="truncate font-mono text-xs">{summarizeEvent(event, resolver)}</span>
        {hasPayload ? (
          <ChevronRight
            className={cn(
              'ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : null}
      </button>
      {open && hasPayload ? (
        <div className="px-2.5 pb-2">
          <Json data={payload} className="max-h-60" />
        </div>
      ) : null}
    </li>
  )
}

export function LiveFeed({
  events,
  connections = [],
}: {
  events: InspectorEvent[]
  connections?: ConnDescriptor[]
}): React.JSX.Element {
  const [active, setActive] = React.useState<Set<FeedCategory>>(
    () => new Set<FeedCategory>(['lifecycle', 'requests', 'events']),
  )
  const [paused, setPaused] = React.useState(false)
  const [frozen, setFrozen] = React.useState<InspectorEvent[]>([])

  const togglePause = (): void => {
    setPaused((p) => {
      if (!p) setFrozen(events) // freeze the current view
      return !p
    })
  }
  const toggle = (id: FeedCategory): void =>
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const resolver = React.useMemo<FeedResolver>(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    const nodeNames = new Map(connections.map((c) => [c.nodeId, c.nodeName]))
    return {
      conn: (id) => byId.get(id),
      nodeName: (nodeId) => nodeNames.get(nodeId) ?? nodeId.slice(0, 8),
    }
  }, [connections])

  const source = paused ? frozen : events
  const shown = source.filter((e) => active.has(eventCategory(e.type)))

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => toggle(c.id)}
            className={cn(
              'rounded-md border px-2 py-1 text-xs transition-colors',
              active.has(c.id)
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/40',
            )}
          >
            {c.label}
          </button>
        ))}
        <button
          onClick={togglePause}
          className={cn(
            'ml-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
            paused ? 'bg-amber-400/20 text-amber-300' : 'text-muted-foreground hover:bg-accent/40',
          )}
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {paused ? 'Paused' : 'Pause'}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {events.length === 0 ? 'Waiting for events…' : 'No events match the filter.'}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          {shown.map((event, i) => (
            <FeedRow key={i} event={event} resolver={resolver} />
          ))}
        </ul>
      )}
    </div>
  )
}
