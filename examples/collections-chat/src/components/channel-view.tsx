import { useRef, useState, type KeyboardEvent } from 'react'
import { Hash, Lock, Menu, Pencil, Send, Trash2, Users, Wrench } from 'lucide-react'
import { Avatar } from '@/components/avatar'
import { MembersPanel } from '@/components/members-panel'
import { Button } from '@/components/ui/button'
import { ChatInput } from '@/components/ui/chat/chat-input'
import { ChatMessageList } from '@/components/ui/chat/chat-message-list'
import type { Channel, FeedMessage } from '@/contract'
import { useChat, useMessages, useUsers } from '@/lib/chat'
import { useRequest } from '@/lib/superline'
import { cn } from '@/lib/utils'

type FeedPart = NonNullable<FeedMessage['parts']>[number]

const GROUP_WINDOW = 5 * 60 * 1000 // group consecutive messages from the same author within 5 min

interface ChannelViewProps {
  myUserId: string
  channel: Channel
  isMember: boolean
  typingUsers: string[]
  /** Opens the mobile sidebar drawer (the hamburger only renders below `md`). */
  onOpenNav?: () => void
}

export function ChannelView({ myUserId, channel, isMember, typingUsers, onOpenNav }: ChannelViewProps): React.JSX.Element {
  const chat = useChat()
  const users = useUsers()
  const messages = useMessages(channel.id) // live, membership-scoped: empty until you join
  const [joining, setJoining] = useState(false)
  const [showMembers, setShowMembers] = useState(false)

  const nameOf = (userId: string): string => users.get(userId)?.displayName ?? 'unknown'

  const handleJoin = (): void => {
    setJoining(true)
    chat
      .join(channel.id)
      .catch(() => {})
      .finally(() => setJoining(false))
  }

  const { call: ping } = useRequest('typing')

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3 shadow-sm">
        {onOpenNav && (
          <button
            onClick={onOpenNav}
            aria-label="Open channel list"
            className="-ml-1 grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        {channel.visibility === 'private' ? (
          <Lock className="h-5 w-5 text-muted-foreground" />
        ) : (
          <Hash className="h-5 w-5 text-muted-foreground" />
        )}
        <h2 className="font-bold text-foreground">{channel.name}</h2>
        {isMember && <span className="text-sm text-muted-foreground">· {messages.length} messages</span>}
        <div className="ml-auto">
          {isMember && (
            <Button variant="ghost" size="sm" onClick={() => setShowMembers((s) => !s)}>
              <Users className="mr-1 h-4 w-4" /> Members
            </Button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {!isMember ? (
            <JoinGate channel={channel} pending={joining} onJoin={handleJoin} />
          ) : messages.length === 0 ? (
            <Empty channelName={channel.name} />
          ) : (
            <ChatMessageList className="flex-1">
              <MessageRows
                items={messages}
                myUserId={myUserId}
                nameOf={nameOf}
                onEdit={(id, content) => void chat.editMessage(id, { content }).catch(() => {})}
                onDelete={(id) => void chat.deleteMessage(id).catch(() => {})}
              />
            </ChatMessageList>
          )}

          {isMember && (
            <>
              <TypingIndicator users={typingUsers} />
              <Composer
                channelName={channel.name}
                onSend={(text) => void chat.send(channel.id, text).catch(() => {})}
                onType={() => void ping({ channelId: channel.id }).catch(() => {})}
              />
            </>
          )}
        </div>

        {isMember && showMembers && (
          <MembersPanel channel={channel} myUserId={myUserId} onClose={() => setShowMembers(false)} />
        )}
      </div>
    </section>
  )
}

function JoinGate({
  channel,
  pending,
  onJoin,
}: {
  channel: Channel
  pending: boolean
  onJoin: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-lg bg-muted text-muted-foreground">
        <Lock className="h-6 w-6" />
      </div>
      <div>
        <h3 className="text-xl font-bold">#{channel.name}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          You're not in this channel yet. Its messages are hidden by row-level security until you join.
        </p>
      </div>
      <Button onClick={onJoin} disabled={pending}>
        {pending ? 'Joining…' : `Join #${channel.name}`}
      </Button>
    </div>
  )
}

function MessageRows({
  items,
  myUserId,
  nameOf,
  onEdit,
  onDelete,
}: {
  items: FeedMessage[]
  myUserId: string
  nameOf: (id: string) => string
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const rows: React.ReactNode[] = []
  let lastDay = ''
  let lastFrom = ''
  let lastAt = 0

  for (const m of items) {
    const day = new Date(m.createdAt).toDateString()
    if (day !== lastDay) {
      rows.push(<DayDivider key={`day-${m.id}`} at={m.createdAt} />)
      lastDay = day
      lastFrom = ''
      lastAt = 0
    }
    const grouped = m.authorId === lastFrom && m.createdAt - lastAt < GROUP_WINDOW
    rows.push(
      <MessageRow
        key={m.id}
        m={m}
        author={nameOf(m.authorId)}
        grouped={grouped}
        mine={m.authorId === myUserId}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    )
    lastFrom = m.authorId
    lastAt = m.createdAt
  }

  return <>{rows}</>
}

function MessageRow({
  m,
  author,
  grouped,
  mine,
  onEdit,
  onDelete,
}: {
  m: FeedMessage
  author: string
  grouped: boolean
  mine: boolean
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const text = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content)

  const startEdit = (): void => {
    setDraft(text)
    setEditing(true)
  }
  const commit = (): void => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== text) onEdit(m.id, next)
  }

  return (
    <div className={cn('group flex gap-3 px-4 hover:bg-muted/60', grouped ? 'py-0.5' : 'mt-3 py-0.5')}>
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="hidden pr-1 text-right text-[11px] leading-6 text-muted-foreground group-hover:block">
            {timeShort(m.createdAt)}
          </span>
        ) : (
          <Avatar name={author} size={36} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-foreground">
              {author}
              {mine && <span className="ml-1 text-xs font-normal text-muted-foreground">(you)</span>}
            </span>
            <span className="text-xs text-muted-foreground">{timeLong(m.createdAt)}</span>
          </div>
        )}
        {editing ? (
          <div className="mt-1 flex items-end gap-2">
            <ChatInput
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  commit()
                }
                if (e.key === 'Escape') setEditing(false)
              }}
              className="h-auto max-h-40 min-h-[36px] resize-none"
            />
            <Button size="sm" onClick={commit}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : m.status !== undefined ? (
          <StreamedBody m={m} />
        ) : (
          <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
            {text}
            {m.editedAt && <span className="ml-1 text-xs text-muted-foreground">(edited)</span>}
          </div>
        )}
      </div>
      {mine && !editing && (
        <div className="hidden shrink-0 items-start gap-1 group-hover:flex">
          {m.status === undefined && (
            <button
              onClick={startEdit}
              aria-label="Edit message"
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={() => onDelete(m.id)}
            aria-label="Delete message"
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * A STREAMED message (the agent's turn): parts render in tree order — reasoning collapsible, tool
 * calls as expandable chips with a state badge, text as prose — with subagent lanes indented under
 * their delegate call, a live cursor while streaming, and an honest tail for aborted/errored turns.
 * A settled turn whose parts left the recency window falls back to its `content` projection.
 */
function StreamedBody({ m }: { m: FeedMessage }): React.JSX.Element {
  const parts = m.parts ?? []
  const streaming = m.status === 'streaming'
  if (parts.length === 0) {
    const text = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content)
    return (
      <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
        {text}
        {streaming && <Cursor />}
        <StatusTail m={m} />
      </div>
    )
  }
  return (
    <div className="space-y-1">
      {parts.map((p) => (
        <PartView key={p.id} p={p} live={streaming && !p.done} nested={p.parent !== null} />
      ))}
      {/* between parts (model thinking, tool about to start) nothing is in flight — keep a pulse
          visible so the turn reads as alive, not stalled */}
      {streaming && parts.every((p) => p.done) && (
        <div>
          <Cursor />
        </div>
      )}
      <StatusTail m={m} />
    </div>
  )
}

function StatusTail({ m }: { m: FeedMessage }): React.JSX.Element | null {
  if (m.status === 'aborted')
    return <div className="mt-1 text-xs italic text-muted-foreground">⏹ interrupted{m.error ? ` — ${m.error}` : ''}</div>
  if (m.status === 'error') return <div className="mt-1 text-xs text-destructive">⚠ {m.error ?? 'failed'}</div>
  return null
}

function PartView({ p, live, nested }: { p: FeedPart; live: boolean; nested: boolean }): React.JSX.Element {
  const indent = nested ? 'ml-3 border-l-2 border-border pl-3' : ''
  if (p.type === 'text')
    return (
      <div className={cn('whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground', indent)}>
        {p.text}
        {live && <Cursor />}
      </div>
    )
  if (p.type === 'reasoning')
    return (
      <details className={cn('text-sm text-muted-foreground', indent)}>
        <summary className="cursor-pointer select-none text-xs font-medium">💭 Reasoning{live ? '…' : ''}</summary>
        <div className="whitespace-pre-wrap break-words italic">
          {p.text}
          {live && <Cursor />}
        </div>
      </details>
    )
  const badge = p.isError ? 'error' : p.state === 'done' ? 'done' : p.state === 'running' ? 'running' : 'input…'
  return (
    <details className={cn('rounded-md border bg-muted/40 px-2 py-1 text-sm', indent)}>
      <summary className="flex cursor-pointer select-none items-center gap-2">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs">{p.toolName ?? p.toolCallId}</span>
        <span
          className={cn(
            'rounded-full px-1.5 py-px text-[10px] font-medium',
            p.isError ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
          )}
        >
          {badge}
        </span>
      </summary>
      {p.args !== undefined && <Json label="args" value={p.args} />}
      {p.result !== undefined && <Json label="result" value={p.result} />}
    </details>
  )
}

function Json({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-1.5 text-[11px] leading-snug text-muted-foreground">
      {label}: {JSON.stringify(value, null, 1)}
    </pre>
  )
}

function Cursor(): React.JSX.Element {
  return <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle" />
}

function DayDivider({ at }: { at: number }): React.JSX.Element {
  return (
    <div className="relative my-3 flex items-center px-4">
      <div className="h-px flex-1 bg-border" />
      <span className="mx-3 rounded-full border bg-background px-3 py-0.5 text-xs font-semibold text-muted-foreground">
        {dayLabel(at)}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function Empty({ channelName }: { channelName: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col justify-end px-4 pb-4">
      <div className="mb-2 grid h-12 w-12 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Hash className="h-6 w-6" />
      </div>
      <h3 className="text-2xl font-bold">#{channelName}</h3>
      <p className="text-muted-foreground">
        This is the very beginning of the <span className="font-semibold">#{channelName}</span> channel. Say hello 👋
      </p>
    </div>
  )
}

function TypingIndicator({ users }: { users: string[] }): React.JSX.Element {
  const label =
    users.length === 0
      ? ''
      : users.length === 1
        ? `${users[0]} is typing`
        : users.length === 2
          ? `${users[0]} and ${users[1]} are typing`
          : `${users.length} people are typing`

  return (
    <div className="flex h-5 items-center gap-1 px-4 text-xs italic text-muted-foreground">
      {label && (
        <>
          <span>{label}</span>
          <span className="inline-flex gap-0.5">
            <Dot delay="0ms" />
            <Dot delay="150ms" />
            <Dot delay="300ms" />
          </span>
        </>
      )}
    </div>
  )
}

function Dot({ delay }: { delay: string }): React.JSX.Element {
  return (
    <span
      className="inline-block h-1 w-1 animate-bounce rounded-full bg-muted-foreground"
      style={{ animationDelay: delay }}
    />
  )
}

function Composer({
  channelName,
  onSend,
  onType,
}: {
  channelName: string
  onSend: (text: string) => void
  onType: () => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const lastTyped = useRef(0)

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    onSend(trimmed)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onChange = (value: string) => {
    setText(value)
    const now = Date.now()
    if (value && now - lastTyped.current > 1500) {
      lastTyped.current = now
      onType()
    }
  }

  return (
    <div className="px-4 pb-4">
      <div className="flex items-end gap-2 rounded-lg border border-input bg-background p-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring">
        <ChatInput
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message #${channelName}`}
          className="h-auto max-h-40 min-h-[40px] resize-none border-0 shadow-none focus-visible:ring-0"
        />
        <Button size="icon" onClick={submit} disabled={!text.trim()} aria-label="Send message">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function timeLong(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function timeShort(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}
