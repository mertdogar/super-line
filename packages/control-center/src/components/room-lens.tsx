import * as React from 'react'
import { roleColor, type Highlight } from '@/lib/topology'
import { familyColor, familyShort, type TransportFamily } from '@/lib/transport'
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
  transports,
  selected,
  onSelect,
}: {
  roles: string[]
  rooms: string[]
  topics: string[]
  transports: { family: TransportFamily; count: number }[]
  selected: Highlight | null
  onSelect: (h: Highlight | null) => void
}): React.JSX.Element {
  const toggle = (h: Highlight): void =>
    onSelect(selected?.kind === h.kind && selected.value === h.value ? null : h)
  const isSel = (h: Highlight): boolean => selected?.kind === h.kind && selected.value === h.value

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

      <Section title="Transports · highlight">
        {transports.length === 0 ? (
          <Empty />
        ) : (
          transports.map(({ family, count }) => (
            <button
              key={family}
              onClick={() => toggle({ kind: 'transport', value: family })}
              className={cn(
                'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm',
                isSel({ kind: 'transport', value: family })
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50',
              )}
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: familyColor(family) }} />
              <span className="flex-1 truncate">{familyShort(family)}</span>
              <span className="text-xs text-muted-foreground">{count}</span>
            </button>
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
              onClick={() => toggle({ kind: 'room', value: room })}
              className={cn(
                'block w-full truncate rounded px-2 py-1 text-left text-sm',
                isSel({ kind: 'room', value: room })
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50',
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
