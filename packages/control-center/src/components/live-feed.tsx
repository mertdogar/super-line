import * as React from 'react'
import type { ConnDescriptor, InspectorEvent } from '@super-line/core'
import { eventColor, summarizeEvent, type FeedResolver } from '@/lib/events'
import { cn } from '@/lib/utils'

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
        <li key={i} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', eventColor(event.type))} />
          <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{event.type}</span>
          <span className="truncate font-mono text-xs">{summarizeEvent(event, resolver)}</span>
        </li>
      ))}
    </ul>
  )
}
