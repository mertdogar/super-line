import { useEffect, useState, type FormEvent } from 'react'
import { createClient } from '@super-line/client'
import { createSocketReact } from '@super-line/react'
import { chat } from './contract.js'

const WS_URL = 'ws://localhost:8787'

const { Provider, useRequest, useEvent, useSubscription } = createSocketReact<typeof chat>()

interface Message {
  id: string
  room: string
  text: string
  from: string
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
  // create the client once; it connects immediately and reconnects on its own
  const [client] = useState(() => createClient(chat, { url: WS_URL, params: { name } }))
  useEffect(() => () => client.close(), [client])

  return (
    <Provider client={client}>
      <Room room={room} me={name} />
    </Provider>
  )
}

function Room({ room, me }: { room: string; me: string }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [online, setOnline] = useState(0)

  const { call: join } = useRequest('join')
  const { call: send, isLoading: sending } = useRequest('send')
  const presence = useSubscription('presence')

  // append messages for this room as they arrive
  useEvent('message', (m) => {
    if (m.room === room) setMessages((prev) => [...prev, m])
  })

  // join once on mount; seed the online count from the response
  useEffect(() => {
    join({ room })
      .then((r) => setOnline(r.count))
      .catch(() => {})
  }, [join, room])

  // keep the count live as others join/leave
  useEffect(() => {
    if (presence?.room === room) setOnline(presence.count)
  }, [presence, room])

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
          {online} online · you are <b>{me}</b>
        </span>
      </header>
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.from === me ? 'mine' : ''}>
            <span className="from">{m.from}</span>
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
