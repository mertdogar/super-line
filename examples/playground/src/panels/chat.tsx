import { useMemo, useState } from 'react'
import { useCollection } from '@super-line/react'
import { partsText } from '@super-line/plugin-chat/client'
import { useChannels, useChat, useMe, useMembers, useMessageParts, useMessages } from '@super-line/plugin-chat/react'
import type { Message } from '../contract'

export function ChatPanel(): React.JSX.Element {
  const chat = useChat()
  const { userId: me } = useMe()
  const channels = useChannels()
  const { rows: users } = useCollection('users')
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users])

  const [activeId, setActiveId] = useState<string | null>(null)
  const active = channels.find((c) => c.id === activeId) ?? channels[0]
  const members = useMembers(active?.id)
  const messages = useMessages(active?.id, { limit: 50 })
  const isMember = members.some((m) => m.userId === me)

  const [draft, setDraft] = useState('')
  const [newChannel, setNewChannel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = (op: Promise<unknown> | undefined) => {
    setError(null)
    op?.catch((err: Error) => setError(err.message))
  }

  return (
    <section className="panel chat">
      <h2>Chat · plugin-chat</h2>
      <div className="row">
        <select value={active?.id ?? ''} onChange={(e) => setActiveId(e.target.value)}>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name} {c.visibility === 'private' ? '(private)' : ''}
            </option>
          ))}
        </select>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newChannel.trim()) return
            run(chat?.createChannel({ name: newChannel.trim() }).then((c) => setActiveId(c.id)))
            setNewChannel('')
          }}
        >
          <input placeholder="new channel" value={newChannel} onChange={(e) => setNewChannel(e.target.value)} />
          <button type="submit">Create</button>
        </form>
      </div>
      <p className="muted">
        members: {members.map((m) => names.get(m.userId) ?? m.userId.slice(0, 6)).join(', ') || '—'}
      </p>

      <ol className="messages">
        {messages.map((m) => (
          <li key={m.id}>
            <b>{names.get(m.authorId) ?? m.authorId.slice(0, 6)}</b> <MessageBody m={m} />
          </li>
        ))}
      </ol>

      {active && !isMember ? (
        <button onClick={() => run(chat?.join(active.id))}>Join #{active.name}</button>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (!active || !draft.trim()) return
            run(chat?.send(active.id, draft))
            setDraft('')
          }}
        >
          <input className="grow" placeholder="message — try “/bot hello”" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit">Send</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function MessageBody({ m }: { m: Message }): React.JSX.Element {
  if (m.status === 'streaming') return <Streaming m={m} />
  return (
    <>
      {String(m.content ?? '')}
      {m.status && m.status !== 'complete' && <span className="tag">{m.status}</span>}
    </>
  )
}

/** A still-streaming message: its live parts, assembled from the ephemeral deltas the bot worker pushes. */
function Streaming({ m }: { m: Message }): React.JSX.Element {
  const parts = useMessageParts(m.channelId, m.id)
  return (
    <>
      {partsText(parts)}
      <span className="caret">▍</span>
    </>
  )
}
