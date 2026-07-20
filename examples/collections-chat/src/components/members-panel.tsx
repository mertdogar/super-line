import { useMemo, useState } from 'react'
import { Crown, ShieldOff, UserMinus, UserPlus, X } from 'lucide-react'
import { Avatar } from '@/components/avatar'
import type { Channel } from '@/contract'
import { useChat, useMembers, useMyRole, useUsers } from '@/lib/chat'
import { cn } from '@/lib/utils'

/**
 * The membership-control panel — the plugin capability the old store-based example couldn't express.
 * Everyone sees the member list; owners get add / remove / promote / demote, each a server-authorized
 * request (the server re-checks ownership, so a tampered client just gets FORBIDDEN).
 */
export function MembersPanel({
  channel,
  myUserId,
  onClose,
}: {
  channel: Channel
  myUserId: string
  onClose: () => void
}): React.JSX.Element {
  const chat = useChat()
  const users = useUsers()
  const members = useMembers(channel.id)
  const myRole = useMyRole(channel.id)
  const amOwner = myRole === 'owner'

  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members])
  const nameOf = (id: string): string => users.get(id)?.displayName ?? 'unknown'

  const act = (p: Promise<unknown>): void => void p.catch(() => {})

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-72 shrink-0 flex-col border-l bg-background shadow-lg md:static md:z-auto md:shadow-none">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <span className="font-semibold">Members — {members.length}</span>
        <button type="button"
          onClick={onClose}
          aria-label="Close members"
          className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {members.map((m) => (
            <li key={m.id} className="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/60">
              <Avatar name={nameOf(m.userId)} size={28} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {nameOf(m.userId)}
                {m.userId === myUserId && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
              </span>
              {m.role === 'owner' && <Crown className="h-3.5 w-3.5 text-amber-500" aria-label="Owner" />}
              {amOwner && (
                <div className="hidden shrink-0 items-center gap-1 group-hover:flex">
                  {m.role === 'owner' ? (
                    <IconBtn
                      title="Demote to member"
                      onClick={() => act(chat.setMemberRole(channel.id, m.userId, 'member'))}
                    >
                      <ShieldOff className="h-3.5 w-3.5" />
                    </IconBtn>
                  ) : (
                    <IconBtn
                      title="Promote to owner"
                      onClick={() => act(chat.setMemberRole(channel.id, m.userId, 'owner'))}
                    >
                      <Crown className="h-3.5 w-3.5" />
                    </IconBtn>
                  )}
                  {m.userId !== myUserId && (
                    <IconBtn title="Remove from channel" onClick={() => act(chat.removeMember(channel.id, m.userId))}>
                      <UserMinus className="h-3.5 w-3.5" />
                    </IconBtn>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {amOwner && <AddMember channel={channel} exclude={memberIds} onAdd={(uid) => act(chat.addMember(channel.id, uid))} />}
    </aside>
  )
}

function AddMember({
  channel,
  exclude,
  onAdd,
}: {
  channel: Channel
  exclude: Set<string>
  onAdd: (userId: string) => void
}): React.JSX.Element {
  const users = useUsers()
  const [query, setQuery] = useState('')
  const candidates = useMemo(
    () =>
      [...users.values()]
        .filter((u) => !exclude.has(u.id) && !u.deletedAt)
        .filter((u) => u.displayName.toLowerCase().includes(query.trim().toLowerCase()))
        .slice(0, 6),
    [users, exclude, query],
  )

  return (
    <div className="border-t p-3">
      <label className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <UserPlus className="h-3.5 w-3.5" /> Add to #{channel.name}
      </label>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people…"
        className="mb-2 h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {query.trim() && (
        <ul className="space-y-0.5">
          {candidates.length === 0 ? (
            <li className="px-1 py-1 text-xs text-muted-foreground">No matches</li>
          ) : (
            candidates.map((u) => (
              <li key={u.id}>
                <button type="button"
                  onClick={() => {
                    onAdd(u.id)
                    setQuery('')
                  }}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
                >
                  <Avatar name={u.displayName} size={24} />
                  <span className="truncate">{u.displayName}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn('grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground')}
    >
      {children}
    </button>
  )
}
