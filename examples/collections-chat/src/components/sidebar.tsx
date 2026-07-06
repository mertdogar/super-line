import { useMemo } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Hash, Lock, LogOut, MessageSquare } from 'lucide-react'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import type { Channel, Message } from '@/contract'
import { useChat } from '@/lib/chat'
import { cn } from '@/lib/utils'

interface SidebarProps {
  myName: string
  online: string[]
  channels: Channel[]
  joined: string[]
  activeId: string
  onSelect: (id: string) => void
  lastRead: Record<string, number>
  onSignOut: () => void
}

export function Sidebar({
  myName,
  online,
  channels,
  joined,
  activeId,
  onSelect,
  lastRead,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  const { me, messages } = useChat()
  const joinedSet = useMemo(() => new Set(joined), [joined])

  // Unread is derived entirely client-side from the ONE synced messages collection (already limited to
  // your joined channels by row-level security): count messages newer than each channel's last-read
  // marker that aren't your own.
  const { data: msgs } = useLiveQuery((q) => q.from({ m: messages }))
  const unreadByChannel = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of msgs as Message[]) {
      if (m.authorId === me) continue
      if (m.createdAt > (lastRead[m.channelId] ?? 0)) counts[m.channelId] = (counts[m.channelId] ?? 0) + 1
    }
    return counts
  }, [msgs, lastRead, me])

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
          <span className="text-xs font-semibold uppercase tracking-wide text-sidebar-muted">Channels</span>
          <CreateChannelDialog onCreated={onSelect} />
        </div>
        <nav className="space-y-0.5 px-2">
          {channels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              joined={joinedSet.has(c.id)}
              active={c.id === activeId}
              unread={c.id === activeId ? 0 : (unreadByChannel[c.id] ?? 0)}
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
              <span className={cn('truncate', u === myName ? 'font-semibold' : 'text-sidebar-muted')}>
                {u}
                {u === myName && ' (you)'}
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
  joined,
  active,
  unread,
  onSelect,
}: {
  channel: Channel
  joined: boolean
  active: boolean
  unread: number
  onSelect: (id: string) => void
}): React.JSX.Element {
  const hasUnread = unread > 0
  const Icon = joined ? Hash : Lock

  return (
    <button
      onClick={() => onSelect(channel.id)}
      title={joined ? undefined : `Join #${channel.name} to see the conversation`}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1 text-[15px]',
        active
          ? 'bg-sidebar-active text-sidebar-active-foreground'
          : !joined
            ? 'text-sidebar-muted/70 hover:bg-sidebar-accent'
            : hasUnread
              ? 'font-semibold text-sidebar-foreground hover:bg-sidebar-accent'
              : 'text-sidebar-muted hover:bg-sidebar-accent',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="flex-1 truncate text-left">{channel.name}</span>
      {hasUnread && (
        <span className="min-w-5 rounded-full bg-white px-1.5 text-center text-xs font-bold text-sidebar">
          {unread}
        </span>
      )}
    </button>
  )
}
