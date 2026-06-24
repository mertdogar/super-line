import { Hash, LogOut, MessageSquare } from 'lucide-react'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import type { Channel, MessagesDoc } from '@/contract'
import { useResource } from '@/lib/superline'
import { cn } from '@/lib/utils'

interface SidebarProps {
  me: string
  online: string[]
  channels: Channel[]
  activeId: string
  onSelect: (id: string) => void
  lastRead: Record<string, number>
  onSignOut: () => void
}

export function Sidebar({
  me,
  online,
  channels,
  activeId,
  onSelect,
  lastRead,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  return (
    <aside className="flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
        <span className="flex items-center gap-2 text-lg font-bold">
          <MessageSquare className="h-5 w-5" />
          super-line
        </span>
        <button
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          className="grid h-7 w-7 place-items-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-3">
        <div className="mb-1 flex items-center justify-between px-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-sidebar-muted">
            Channels
          </span>
          <CreateChannelDialog onCreated={onSelect} />
        </div>
        <nav className="space-y-0.5 px-2">
          {channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              me={me}
              active={c.id === activeId}
              lastReadAt={lastRead[c.id] ?? 0}
              onSelect={onSelect}
            />
          ))}
        </nav>
      </div>

      <div className="border-t border-sidebar-border px-3 py-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-sidebar-muted">
          Online — {online.length}
        </div>
        <ul className="space-y-1.5">
          {online.map((u) => (
            <li key={u} className="flex items-center gap-2 text-sm">
              <span className="h-2 w-2 rounded-full bg-online shadow-[0_0_0_2px_var(--sidebar)]" />
              <span className={cn('truncate', u === me ? 'font-semibold' : 'text-sidebar-muted')}>
                {u}
                {u === me && ' (you)'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}

function ChannelRow({
  channel,
  me,
  active,
  lastReadAt,
  onSelect,
}: {
  channel: Channel
  me: string
  active: boolean
  lastReadAt: number
  onSelect: (id: string) => void
}): React.JSX.Element {
  // Each row subscribes to its own channel's messages — so unread counts stay live across the whole
  // sidebar, derived purely from the synced Resource (no server-side read state).
  const { data } = useResource<MessagesDoc>('chat', `messages:${channel.id}`)
  const items = data?.items ?? []
  const unread = active ? 0 : items.filter((m) => m.at > lastReadAt && m.from !== me).length
  const hasUnread = unread > 0

  return (
    <button
      onClick={() => onSelect(channel.id)}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1 text-[15px]',
        active
          ? 'bg-sidebar-active text-sidebar-active-foreground'
          : hasUnread
            ? 'font-semibold text-sidebar-foreground hover:bg-sidebar-accent'
            : 'text-sidebar-muted hover:bg-sidebar-accent',
      )}
    >
      <Hash className="h-4 w-4 shrink-0 opacity-70" />
      <span className="flex-1 truncate text-left">{channel.name}</span>
      {hasUnread && (
        <span className="min-w-5 rounded-full bg-white px-1.5 text-center text-xs font-bold text-sidebar">
          {unread}
        </span>
      )}
    </button>
  )
}
