// The channel sidebar — the harness cockpit's "threads" list, in chat terms: every channel is a
// separate conversation with the supervisor (it watches all public channels). Mobile: rendered as
// an off-canvas drawer by <Chat/>.

import { useState, type KeyboardEvent } from 'react'
import { Hash, LogOut, Network, Plus } from 'lucide-react'

export interface ChannelItem {
  id: string
  name: string
}

export function Sidebar({
  myName,
  channels,
  activeId,
  onSelect,
  onCreate,
  onSignOut,
}: {
  myName: string
  channels: ChannelItem[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: (name: string) => void
  onSignOut: () => void
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')

  const submit = (): void => {
    const n = name.trim()
    setCreating(false)
    setName('')
    if (n) onCreate(n)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') setCreating(false)
  }

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <header className="flex items-center gap-2 border-b border-sidebar-border px-4 py-3">
        <Network className="h-5 w-5" />
        <span className="text-lg font-bold">chat supervisor</span>
      </header>

      <div className="flex-1 overflow-y-auto py-3">
        <div className="mb-1 flex items-center justify-between px-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-sidebar-muted">Conversations</span>
          <button
            onClick={() => setCreating((c) => !c)}
            aria-label="New channel"
            className="grid h-6 w-6 place-items-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        {creating && (
          <div className="px-2 pb-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={submit}
              placeholder="channel name…"
              className="w-full rounded-md border border-sidebar-border bg-transparent px-2 py-1.5 text-sm placeholder:text-sidebar-muted focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
        )}
        <nav className="space-y-0.5 px-2">
          {channels.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                c.id === activeId
                  ? 'bg-primary text-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent'
              }`}
            >
              <Hash className="h-4 w-4 shrink-0 opacity-70" />
              <span className="truncate">{c.name}</span>
            </button>
          ))}
        </nav>
      </div>

      <footer className="flex items-center justify-between border-t border-sidebar-border px-4 py-3 text-sm">
        <span className="truncate font-medium">{myName}</span>
        <button
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          className="grid h-7 w-7 place-items-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </footer>
    </aside>
  )
}
