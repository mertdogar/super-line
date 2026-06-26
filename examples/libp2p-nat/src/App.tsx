import { useEffect, useState, type FormEvent } from 'react'
import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { webRTC } from '@libp2p/webrtc'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { gossipsub } from '@libp2p/gossipsub'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { multiaddr } from '@multiformats/multiaddr'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { libp2pClientTransport } from '@super-line/transport-libp2p'
import { createSuperLineHooks } from '@super-line/react'
import { chat } from './contract.js'

// Injected at build time by vite.config.ts (deterministic relay addr + public server PeerIds — no
// private keys ever reach the browser). The relay is the one fixed public node; servers are found
// dynamically via pubsub and matched against this known-server set.
declare const __RELAY_ADDR__: string
declare const __SERVER_PEER_IDS__: string[]
declare const __DISCOVERY_TOPIC__: string

const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof chat, 'user'>()

interface Message {
  id: string
  room: string
  text: string
  from: string
  node: string
  at: number
}

// Build a browser libp2p node, bootstrap to the relay, discover a live server via pubsub, then dial
// it over webrtc — exactly the path the headless probe proved.
async function connect(name: string): Promise<{ client: SuperLineClient<typeof chat, 'user'>; node: Awaited<ReturnType<typeof createLibp2p>> }> {
  const node = await createLibp2p({
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    peerDiscovery: [pubsubPeerDiscovery({ topics: [__DISCOVERY_TOPIC__], interval: 5_000 })],
    services: { identify: identify(), pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }) },
  })
  try {
    await node.dial(multiaddr(__RELAY_ADDR__), { signal: AbortSignal.timeout(15_000) })

    const known = new Set(__SERVER_PEER_IDS__)
    const serverId = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no server discovered (is one up?)')), 30_000)
      node.addEventListener('peer:discovery', (e) => {
        const id = e.detail.id.toString()
        if (!known.has(id)) return // ignore the relay and other browsers
        clearTimeout(t)
        resolve(id)
      })
    })

    const addr = `${__RELAY_ADDR__}/p2p-circuit/webrtc/p2p/${serverId}`
    const client = createSuperLineClient(chat, {
      transport: libp2pClientTransport({ node, multiaddr: multiaddr(addr) }),
      role: 'user',
      params: { name },
    })
    return { client, node }
  } catch (e) {
    void node.stop() // dial/discovery failed — don't leak the started node + its relay reservation
    throw e
  }
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
      <h1>super-line chat · behind NAT via libp2p</h1>
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
  const [client, setClient] = useState<SuperLineClient<typeof chat, 'user'> | null>(null)
  const [status, setStatus] = useState('discovering a server over libp2p…')

  useEffect(() => {
    let cancelled = false
    let active: Awaited<ReturnType<typeof connect>> | undefined
    connect(name)
      .then((r) => {
        if (cancelled) {
          r.client.close()
          void r.node.stop()
          return
        }
        active = r
        setClient(r.client)
      })
      .catch((e: unknown) => setStatus('❌ ' + (e instanceof Error ? e.message : String(e))))
    return () => {
      cancelled = true
      active?.client.close()
      void active?.node.stop()
    }
  }, [name])

  if (!client) return <div className="status">{status}</div>
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
  const [node, setNode] = useState('…')

  const { call: join } = useRequest('join')
  const { call: send, isLoading: sending } = useRequest('send')
  const presence = useSubscription('presence')

  useEvent('message', (m) => {
    if (m.room === room) setMessages((prev) => [...prev, m])
  })

  useEffect(() => {
    join({ room })
      .then((r) => {
        setOnline(r.count)
        setNode(r.node)
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
    <div className="chat">
      <header>
        <strong>#{room}</strong>
        <span>
          {online} online · you are <b>{me}</b> on <b>{node}</b> · <span className="wire">direct webrtc ⇄ NAT'd server</span>
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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message #${room}`} autoFocus />
        <button type="submit" disabled={sending}>
          Send
        </button>
      </form>
    </div>
  )
}
