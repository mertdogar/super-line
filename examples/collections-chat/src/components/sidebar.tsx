import { useMemo } from 'react'
import { Hash, Lock, LogOut, MessageSquare } from 'lucide-react'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import type { Channel } from '@/contract'
import { cn } from '@/lib/utils'

interface SidebarProps {
  myName: string
  online: string[]
  channels: Channel[]
  joined: string[]
  activeId: string
  onSelect: (id: string) => void
  onSignOut: () => void
}

export function Sidebar({
  myName,
  online,
  channels,
  joined,
  activeId,
  onSelect,
  onSignOut,
}: SidebarProps): React.JSX.Element {
  const joinedSet = useMemo(() => new Set(joined), [joined])

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className="flex items-center justify-between border-b border-sidebar-border px-4 py-3">
        <span className="flex items-center gap-2 text-lg font-bold">
          <MessageSquare className="h-5 w-5" />
          super-line
        </span>
        <button type="button"
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
  onSelect,
}: {
  channel: Channel
  joined: boolean
  active: boolean
  onSelect: (id: string) => void
}): React.JSX.Element {
  // private channels only ever appear here once you're a member, so a Lock icon means "private + joined"
  const Icon = channel.visibility === 'private' ? Lock : Hash

  return (
    <button type="button"
      onClick={() => onSelect(channel.id)}
      title={joined ? undefined : `Join #${channel.name} to see the conversation`}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1 text-[15px]',
        active
          ? 'bg-sidebar-active text-sidebar-active-foreground'
          : !joined
            ? 'text-sidebar-muted/70 hover:bg-sidebar-accent'
            : 'text-sidebar-muted hover:bg-sidebar-accent',
      )}
    >
      <Icon className="h-4 w-4 shrink-0 opacity-70" />
      <span className="flex-1 truncate text-left">{channel.name}</span>
    </button>
  )
}
