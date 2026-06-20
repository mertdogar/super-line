import * as React from 'react'
import { roleColor } from '@/lib/topology'
import { cn } from '@/lib/utils'

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-4">
      <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

const Empty = (): React.JSX.Element => <div className="px-2 py-0.5 text-xs text-muted-foreground">none</div>

export function RoomLens({
  roles,
  rooms,
  topics,
  selected,
  onSelect,
}: {
  roles: string[]
  rooms: string[]
  topics: string[]
  selected: string | null
  onSelect: (room: string | null) => void
}): React.JSX.Element {
  return (
    <aside className="w-60 shrink-0 overflow-auto border-l bg-card/30 p-3">
      <Section title="Roles">
        {roles.length === 0 ? (
          <Empty />
        ) : (
          roles.map((r) => (
            <div key={r} className="flex items-center gap-2 px-1 py-0.5 text-sm">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: roleColor(r) }} />
              {r}
            </div>
          ))
        )}
      </Section>

      <Section title="Rooms · highlight">
        {rooms.length === 0 ? (
          <Empty />
        ) : (
          rooms.map((room) => (
            <button
              key={room}
              onClick={() => onSelect(selected === room ? null : room)}
              className={cn(
                'block w-full truncate rounded px-2 py-1 text-left text-sm',
                selected === room ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              )}
            >
              {room}
            </button>
          ))
        )}
      </Section>

      <Section title="Topics · this node">
        {topics.length === 0 ? (
          <Empty />
        ) : (
          topics.map((t) => (
            <div key={t} className="truncate px-2 py-0.5 text-sm text-muted-foreground">
              {t}
            </div>
          ))
        )}
      </Section>
    </aside>
  )
}
