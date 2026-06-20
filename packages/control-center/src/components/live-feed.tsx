import * as React from 'react'
import type { InspectorEvent } from '@super-line/core'
import { eventColor, summarizeEvent } from '@/lib/events'
import { cn } from '@/lib/utils'

export function LiveFeed({ events }: { events: InspectorEvent[] }): React.JSX.Element {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">Waiting for events…</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {events.map((event, i) => (
        <li key={i} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', eventColor(event.type))} />
          <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{event.type}</span>
          <span className="truncate font-mono text-xs">{summarizeEvent(event)}</span>
        </li>
      ))}
    </ul>
  )
}
