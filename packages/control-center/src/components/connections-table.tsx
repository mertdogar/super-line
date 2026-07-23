import * as React from 'react'
import type { ConnDescriptor } from '@super-line/core'
import { formatDuration, formatTime } from '@/lib/events'
import { roleColor } from '@/lib/topology'
import { transportColor, transportLabel } from '@/lib/transport'
import { displayNameOf, shortId, type Directory } from '@/lib/identity'
import { clickable, cn } from '@/lib/utils'

/** Who holds this connection: the directory name over the raw key, which stays visible because it's what
 *  correlates a row with the live feed and the drawer. */
function UserCell({ userId, directory }: { userId?: string; directory: Directory }): React.JSX.Element {
  if (!userId) return <span className="text-muted-foreground">—</span>
  const name = displayNameOf(directory, userId)
  return (
    <span className="flex flex-col leading-tight" title={userId}>
      {name ? <span>{name}</span> : null}
      <span className={cn('font-mono text-xs', name && 'text-muted-foreground')}>{shortId(userId)}</span>
    </span>
  )
}

export function ConnectionsTable({
  connections,
  directory,
  selectedId,
  onSelect,
}: {
  connections: ConnDescriptor[]
  directory: Directory
  selectedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  if (connections.length === 0) {
    return <p className="text-sm text-muted-foreground">No connections.</p>
  }
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b bg-card/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-2 font-medium">role</th>
            <th className="px-3 py-2 font-medium">transport</th>
            <th className="px-3 py-2 font-medium">id</th>
            <th className="px-3 py-2 font-medium">user</th>
            <th className="px-3 py-2 font-medium">node</th>
            <th className="px-3 py-2 font-medium">rooms</th>
            <th className="px-3 py-2 font-medium">connected</th>
          </tr>
        </thead>
        <tbody>
          {connections.map((c) => (
            <tr
              key={c.id}
              {...clickable(() => onSelect(c.id))}
              className={cn(
                'cursor-pointer border-b last:border-0 hover:bg-accent/40',
                selectedId === c.id && 'bg-accent/60',
              )}
            >
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: roleColor(c.role) }} />
                  {c.role}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: transportColor(c.transport) }} />
                  {transportLabel(c.transport)}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-xs">{c.id.slice(0, 8)}</td>
              <td className="px-3 py-2">
                <UserCell userId={c.userId} directory={directory} />
              </td>
              <td className="px-3 py-2 text-xs">{c.nodeName}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {c.rooms.length ? c.rooms.join(', ') : '—'}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">
                {formatTime(c.connectedAt)} <span className="opacity-60">· {formatDuration(c.connectedAt)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
