import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Hash, Send } from 'lucide-react'
import { Avatar } from '@/components/avatar'
import { Button } from '@/components/ui/button'
import { ChatInput } from '@/components/ui/chat/chat-input'
import { ChatMessageList } from '@/components/ui/chat/chat-message-list'
import type { Message, MessagesDoc } from '@/contract'
import type { ReadState } from '@/hooks/use-read-state'
import { useRequest, useResource } from '@/lib/superline'
import { cn } from '@/lib/utils'

const GROUP_WINDOW = 5 * 60 * 1000 // group consecutive messages from the same author within 5 min

interface ChannelViewProps {
  me: string
  channelId: string
  channelName: string
  typingUsers: string[]
  markRead: ReadState['markRead']
}

export function ChannelView({
  me,
  channelId,
  channelName,
  typingUsers,
  markRead,
}: ChannelViewProps): React.JSX.Element {
  const { data } = useResource<MessagesDoc>('chat', `messages:${channelId}`)
  const items = data?.items ?? []
  const latestAt = items.length ? items[items.length - 1]!.at : 0

  // viewing a channel marks it read up to its newest message
  useEffect(() => {
    if (latestAt) markRead(channelId, latestAt)
  }, [channelId, latestAt, markRead])

  const { call: send } = useRequest('send')
  const { call: ping } = useRequest('typing')

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-4 py-3 shadow-sm">
        <Hash className="h-5 w-5 text-muted-foreground" />
        <h2 className="font-bold text-foreground">{channelName}</h2>
        <span className="text-sm text-muted-foreground">· {items.length} messages</span>
      </header>

      {data === undefined ? (
        <div className="grid flex-1 place-items-center text-sm text-muted-foreground">connecting…</div>
      ) : items.length === 0 ? (
        <Empty channelName={channelName} />
      ) : (
        <ChatMessageList className="flex-1">
          <MessageRows items={items} me={me} />
        </ChatMessageList>
      )}

      <TypingIndicator users={typingUsers} />

      <Composer
        channelName={channelName}
        onSend={(text) => void send({ channel: channelId, text }).catch(() => {})}
        onType={() => void ping({ channel: channelId }).catch(() => {})}
      />
    </section>
  )
}

function MessageRows({ items, me }: { items: Message[]; me: string }): React.JSX.Element {
  const rows: React.ReactNode[] = []
  let lastDay = ''
  let lastFrom = ''
  let lastAt = 0

  for (const m of items) {
    const day = new Date(m.at).toDateString()
    if (day !== lastDay) {
      rows.push(<DayDivider key={`day-${m.id}`} at={m.at} />)
      lastDay = day
      lastFrom = ''
      lastAt = 0
    }
    const grouped = m.from === lastFrom && m.at - lastAt < GROUP_WINDOW
    rows.push(<MessageRow key={m.id} m={m} grouped={grouped} mine={m.from === me} />)
    lastFrom = m.from
    lastAt = m.at
  }

  return <>{rows}</>
}

function MessageRow({
  m,
  grouped,
  mine,
}: {
  m: Message
  grouped: boolean
  mine: boolean
}): React.JSX.Element {
  return (
    <div className={cn('group flex gap-3 px-4 hover:bg-muted/60', grouped ? 'py-0.5' : 'mt-3 py-0.5')}>
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="hidden pr-1 text-right text-[11px] leading-6 text-muted-foreground group-hover:block">
            {timeShort(m.at)}
          </span>
        ) : (
          <Avatar name={m.from} size={36} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-foreground">
              {m.from}
              {mine && <span className="ml-1 text-xs font-normal text-muted-foreground">(you)</span>}
            </span>
            <span className="text-xs text-muted-foreground">{timeLong(m.at)}</span>
          </div>
        )}
        <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-foreground">
          {m.text}
        </div>
      </div>
    </div>
  )
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
        This is the very beginning of the <span className="font-semibold">#{channelName}</span>{' '}
        channel. Say hello 👋
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
