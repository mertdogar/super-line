import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineHooks } from '@super-line/react'
import { chat } from './contract.js'
import { transportFor, TRANSPORT_LABELS, type TransportKind } from './transport.js'

const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof chat, 'user'>()

type Client = SuperLineClient<typeof chat, 'user'>

interface Message {
  id: string
  room: string
  text: string
  from: string
  via: string
  at: number
  system?: boolean
}

// 'sse' | 'longpoll' both mean the HTTP transport in the dial
const displayVia = (via: string) => (via === 'sse' || via === 'longpoll' ? 'http' : via)

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
      <p className="sub">same app, any wire — pick a transport once you're in</p>
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
  const [kind, setKind] = useState<TransportKind>('websocket')
  const [client, setClient] = useState<Client | null>(null)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  // message history is LIFTED here so it survives a transport switch (the chat subtree remounts)
  const [messages, setMessages] = useState<Message[]>([])
  const addMessage = useRef((m: Message) => setMessages((prev) => [...prev, m]))

  // (re)build the super-line client whenever the dial changes — the ONLY thing that differs is the transport
  useEffect(() => {
    let cancelled = false
    let c: Client | undefined
    setStatus('connecting')
    setClient(null)
    void transportFor(kind)
      .then((transport) => {
        if (cancelled) return
        c = createSuperLineClient(chat, { transport, role: 'user', params: { name } })
        setClient(c)
      })
      .catch(() => !cancelled && setStatus('closed'))
    return () => {
      cancelled = true
      c?.close()
    }
  }, [kind, name])

  // reflect the live connection state in the status pill
  useEffect(() => {
    if (!client) return
    const tick = () => setStatus(client.connected ? 'connected' : 'connecting')
    tick()
    const t = setInterval(tick, 300)
    return () => clearInterval(t)
  }, [client])

  const onSwitch = (next: TransportKind) => {
    if (next === kind) return
    addMessage.current({
      id: `sys_${Date.now()}`,
      room,
      from: 'system',
      text: `switched to ${TRANSPORT_LABELS[next]}`,
      via: next,
      at: Date.now(),
      system: true,
    })
    setKind(next)
  }

  return (
    <div className="chat">
      <header>
        <strong>#{room}</strong>
        <div className="dialbar">
          <label className="dial">
            transport
            <select value={kind} onChange={(e) => onSwitch(e.target.value as TransportKind)}>
              {(Object.keys(TRANSPORT_LABELS) as TransportKind[]).map((k) => (
                <option key={k} value={k}>
                  {TRANSPORT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <span className={`status-pill ${status}`}>{status}</span>
        </div>
      </header>
      {client ? (
        // re-key on the transport so the room re-joins + re-subscribes on the fresh client;
        // `messages` lives above this key, so history persists across the switch
        <Provider client={client} key={kind}>
          <Room room={room} me={name} kind={kind} messages={messages} onMessage={addMessage.current} />
        </Provider>
      ) : (
        <ul className="messages">
          <li className="system">
            <span className="text">connecting over {TRANSPORT_LABELS[kind]}…</span>
          </li>
        </ul>
      )}
    </div>
  )
}

function Room({
  room,
  me,
  kind,
  messages,
  onMessage,
}: {
  room: string
  me: string
  kind: TransportKind
  messages: Message[]
  onMessage: (m: Message) => void
}) {
  const [text, setText] = useState('')
  const [online, setOnline] = useState(0)
  const [via, setVia] = useState('…')

  const { call: join } = useRequest('join')
  const { call: send, isLoading: sending } = useRequest('send')
  const presence = useSubscription('presence')

  useEvent('message', (m) => {
    if (m.room === room) onMessage(m)
  })

  useEffect(() => {
    join({ room })
      .then((r) => {
        setOnline(r.count)
        setVia(r.via)
      })
      .catch(() => {})
  }, [join, room])

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
    <>
      <p className="banner">
        {online} online · you are <b>{me}</b> · connected over <b>{displayVia(via)}</b> (dial: {TRANSPORT_LABELS[kind]})
      </p>
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.system ? 'system' : m.from === me ? 'mine' : ''}>
            {!m.system && (
              <span className="from">
                {m.from} · <em>{displayVia(m.via)}</em>
              </span>
            )}
            <span className="text">{m.text}</span>
          </li>
        ))}
      </ul>
      <form className="composer" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message #${room}`} autoFocus />
        <button type="submit" disabled={sending}>
          Send
        </button>
      </form>
    </>
  )
}
