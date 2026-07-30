import { useState, type FormEvent } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createSuperLineHooks, useSuperLineClient } from '@super-line/react'
import { chat } from './contract.js'

// Same-origin: Caddy serves this SPA and reverse-proxies /ws round-robin to the nodes, so the
// WebSocket URL is derived from the page's own host — no hardcoded port, works behind the LB.
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof chat, 'user'>()

interface Message {
  id: string
  room: string
  text: string
  from: string
  node: string
  at: number
}

export function App() {
  const [creds, setCreds] = useState<{ name: string; room: string } | null>(null)
  return creds ? <ChatApp name={creds.name} room={creds.room} /> : <JoinForm onJoin={setCreds} />
}

function JoinForm({ onJoin }: { onJoin: (creds: { name: string; room: string }) => void }) {
  const [name, setName] = useState('')
  const [room, setRoom] = useState('lobby')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed) onJoin({ name: trimmed, room: room.trim() || 'lobby' })
  }

  return (
    <form className="join" onSubmit={submit}>
      <h1>super-line chat</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ada" autoFocus />
      </label>
      <label>
        Room
        <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="lobby" />
      </label>
      <button type="submit">Join</button>
    </form>
  )
}

function ChatApp({ name, room }: { name: string; room: string }) {
  // StrictMode-safe ownership: built in a committed effect, closed on unmount, rebuilt if `name` changes
  const client = useSuperLineClient(
    () => createSuperLineClient(chat, { transport: webSocketClientTransport({ url: WS_URL }), role: 'user', params: { name } }),
    [name],
  )

  return (
    <Provider client={client}>
      <Room room={room} me={name} />
    </Provider>
  )
}

function Room({ room, me }: { room: string; me: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')

  // auto-fetch: joins on mount (exactly once, even under StrictMode) and re-joins if the room changes
  const { data: joined } = useRequest('join', { room })
  const { call: send, loading: sending } = useRequest('send')
  const presence = useSubscription('presence')

  // append messages for this room as they arrive (from any node, via the adapter)
  useEvent('message', (m) => {
    if (m.room === room) setMessages((prev) => [...prev, m])
  })

  // live presence once it has arrived for this room; the join response seeds the count before that,
  // and also names which node holds this socket
  const online = presence?.room === room ? presence.count : (joined?.count ?? 0)
  const node = joined?.node ?? '…'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    setText('')
    send({ room, text: trimmed }).catch(() => {})
  }

  return (
    <div className="chat">
      <header>
        <strong>#{room}</strong>
        <span>
          {online} online · you are <b>{me}</b> on <b>{node}</b>
        </span>
      </header>
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.from === me ? 'mine' : ''}>
            <span className="from">
              {m.from}@{m.node}
            </span>
            <span className="text">{m.text}</span>
          </li>
        ))}
      </ul>
      <form className="composer" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message #${room}`}
          autoFocus
        />
        <button type="submit" disabled={sending}>
          Send
        </button>
      </form>
    </div>
  )
}
