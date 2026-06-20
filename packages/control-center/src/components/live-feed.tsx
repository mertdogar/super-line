import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import type { ConnDescriptor, InspectorEvent } from '@super-line/core'
import { eventColor, eventPayload, summarizeEvent, type FeedResolver } from '@/lib/events'
import { Json } from '@/components/json-view'
import { cn } from '@/lib/utils'

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
  const resolver = React.useMemo<FeedResolver>(() => {
    const byId = new Map(connections.map((c) => [c.id, c]))
    const nodeNames = new Map(connections.map((c) => [c.nodeId, c.nodeName]))
    return {
      conn: (id) => byId.get(id),
      nodeName: (nodeId) => nodeNames.get(nodeId) ?? nodeId.slice(0, 8),
    }
  }, [connections])

  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">Waiting for events…</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {events.map((event, i) => (
        <FeedRow key={i} event={event} resolver={resolver} />
      ))}
    </ul>
  )
}
