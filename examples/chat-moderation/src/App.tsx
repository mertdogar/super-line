import { useCallback, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createSuperLineHooks } from '@super-line/react'
import { chat } from './contract.js'
import { moderationClient } from './moderation/client.js'

// derive the server host from the page URL, so opening the app from a phone on the same
// network (e.g. http://<tailscale-ip>:5173) connects back to this machine, not the phone
const WS_URL = `ws://${window.location.hostname}:8787`

const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof chat, 'user'>()

interface Message {
  id: string
  room: string
  text: string
  from: string
  at: number
}

interface Creds {
  name: string
  room: string
  mod: boolean
}

export function App() {
  const [creds, setCreds] = useState<Creds | null>(null)
  return creds ? <ChatApp {...creds} /> : <JoinForm onJoin={setCreds} />
}

function JoinForm({ onJoin }: { onJoin: (creds: Creds) => void }) {
  const [name, setName] = useState('')
  const [room, setRoom] = useState('lobby')
  const [mod, setMod] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed) onJoin({ name: trimmed, room: room.trim() || 'lobby', mod })
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
      <label className="check">
        <input type="checkbox" checked={mod} onChange={(e) => setMod(e.target.checked)} />
        Join as moderator
      </label>
      <button type="submit">Join</button>
    </form>
  )
}

function ChatApp({ name, room, mod }: Creds) {
  const resyncRef = useRef<() => void>(() => {})
  // the moderation client half re-syncs the mutelist on reconnect via this ref
  const [client] = useState(() =>
    createSuperLineClient(chat, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: 'user',
      params: { name, mod: mod ? '1' : '' },
      plugins: [moderationClient({ onReconnect: () => resyncRef.current() })],
    }),
  )
  useEffect(() => () => client.close(), [client])

  return (
    <Provider client={client}>
      <Room room={room} me={name} mod={mod} resyncRef={resyncRef} />
    </Provider>
  )
}

function Room({
  room,
  me,
  mod,
  resyncRef,
}: {
  room: string
  me: string
  mod: boolean
  resyncRef: MutableRefObject<() => void>
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [online, setOnline] = useState(0)
  const [muted, setMuted] = useState(false)
  const [mutedBy, setMutedBy] = useState<string | undefined>()

  const { call: join } = useRequest('join')
  const { call: send, isLoading: sending } = useRequest('send')
  const presence = useSubscription('presence')

  useEvent('message', (m) => {
    if (m.room === room) setMessages((prev) => [...prev, m])
  })
  // the server pushes this to a user when their mute status flips (moderation plugin, via toUser)
  useEvent('mod.status', (s) => {
    setMuted(s.muted)
    setMutedBy(s.by)
  })

  useEffect(() => {
    join({ room })
      .then((r) => setOnline(r.count))
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
    // a muted send is rejected server-side with FORBIDDEN by the plugin's middleware; the banner explains why
    send({ room, text: trimmed }).catch(() => {})
  }

  return (
    <div className="chat">
      <header>
        <strong>#{room}</strong>
        <span>
          {online} online · you are <b>{me}</b>
          {mod ? ' 🛡️' : ''}
        </span>
      </header>
      {muted && <div className="banner">🔇 You’ve been muted{mutedBy ? ` by ${mutedBy}` : ''} — messages won’t send.</div>}
      {mod && <ModPanel resyncRef={resyncRef} />}
      <ul className="messages">
        {messages.map((m) => (
          <li key={m.id} className={m.from === me ? 'mine' : ''}>
            <span className="from">{m.from}</span>
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
    </div>
  )
}

function ModPanel({ resyncRef }: { resyncRef: MutableRefObject<() => void> }) {
  const [target, setTarget] = useState('')
  const [muted, setMuted] = useState<string[]>([])

  const { call: mute } = useRequest('mod.mute')
  const { call: unmute } = useRequest('mod.unmute')
  const { call: listMuted } = useRequest('mod.list')

  const refresh = useCallback(() => {
    listMuted({})
      .then((r) => setMuted(r.muted))
      .catch(() => {})
  }, [listMuted])

  useEffect(() => refresh(), [refresh])
  // let the client plugin's onReconnect trigger a re-fetch after a dropped socket
  useEffect(() => {
    resyncRef.current = refresh
  }, [resyncRef, refresh])

  const doMute = (e: FormEvent) => {
    e.preventDefault()
    const u = target.trim()
    if (!u) return
    setTarget('')
    mute({ user: u })
      .then((r) => setMuted(r.muted))
      .catch(() => {})
  }

  const doUnmute = (u: string) => {
    unmute({ user: u })
      .then((r) => setMuted(r.muted))
      .catch(() => {})
  }

  return (
    <div className="modpanel">
      <form className="modform" onSubmit={doMute}>
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="mute a user by name…" />
        <button type="submit">Mute</button>
      </form>
      {muted.length > 0 && (
        <ul className="mutelist">
          {muted.map((u) => (
            <li key={u}>
              <span>{u}</span>
              <button className="ghost" onClick={() => doUnmute(u)}>
                unmute
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
