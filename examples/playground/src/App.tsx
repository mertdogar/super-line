import { useState } from 'react'
import { useAuth } from '@super-line/plugin-auth/react'
import { ChatProvider } from '@super-line/plugin-chat/react'
import { useRequest } from '@super-line/react'
import { ChatPanel } from './panels/chat'
import { PresencePanel } from './panels/presence'
import { QueuesPanel } from './panels/queues'
import { AuthPanel } from './panels/auth'
import { dial, kind, NODES, onCloudflare, pinned, TRANSPORTS, type TransportKind } from './dial'

// Docker: the compose service on :8201. Cloudflare: `pnpm cf:control-center` serves one on :8788.
const CONTROL_CENTER = `${location.protocol}//${location.hostname}:${onCloudflare ? 8788 : 8201}`

export function App(): React.JSX.Element {
  const { state } = useAuth()
  // authed first: a session replacement keeps the incumbent live with `pending` set
  if (state.status === 'authed') return <Playground />
  if (state.pending) return <p className="splash">Connecting over {TRANSPORTS[kind]}…</p>
  return <Login />
}

function Login(): React.JSX.Element {
  const auth = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const run = (op: Promise<void>) => {
    setError(null)
    op.catch((err: Error) => setError(err.message))
  }

  return (
    <div className="login">
      <h1>super-line playground</h1>
      <p className="muted">Each tab holds its own session. Open a second tab and sign in as someone else.</p>
      <div className="row">
        {['Ada', 'Grace', 'Linus'].map((name) => (
          <button key={name} onClick={() => run(auth.signIn({ email: `${name.toLowerCase()}@example.com`, password: 'superline' }))}>
            Sign in as {name}
          </button>
        ))}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          run(mode === 'in' ? auth.signIn({ email, password }) : auth.signUp({ email, password, displayName }))
        }}
      >
        {mode === 'up' && <input placeholder="display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">{mode === 'in' ? 'Sign in' : 'Sign up'}</button>
        <button type="button" className="link" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
          {mode === 'in' ? 'No account? Sign up' : 'Have an account? Sign in'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  )
}

function Playground(): React.JSX.Element {
  const auth = useAuth()
  const { data: where } = useRequest('whereAmI', undefined)

  return (
    <ChatProvider>
      <header>
        <b>super-line playground</b>
        <span>
          {auth.state.displayName} <span className="muted">({auth.state.roles.join(', ')})</span>
        </span>
        <span>
          connected to <b className="node">{where?.node ?? '…'}</b> <span className="muted">conn {where?.connId.slice(0, 8)}</span>
        </span>
        {!onCloudflare && <Dials />}
        <span className="spacer" />
        <a href={CONTROL_CENTER} target="_blank" rel="noreferrer">
          Control Center ↗
        </a>
        <button onClick={() => void auth.signOut()}>Sign out</button>
      </header>
      <main>
        <ChatPanel />
        <PresencePanel />
        {!onCloudflare && <QueuesPanel />}
        <AuthPanel />
      </main>
    </ChatProvider>
  )
}

function Dials(): React.JSX.Element {
  return (
    <>
      <span className="row">
        node:
        {[null, ...NODES].map((n) => (
          <button key={n ?? 'any'} className={n === pinned ? 'small active' : 'small'} onClick={() => dial({ node: n })}>
            {n ?? 'any'}
          </button>
        ))}
      </span>
      <span className="row">
        wire:
        {(Object.keys(TRANSPORTS) as TransportKind[]).map((k) => (
          <button key={k} className={k === kind ? 'small active' : 'small'} onClick={() => dial({ transport: k })}>
            {TRANSPORTS[k]}
          </button>
        ))}
      </span>
    </>
  )
}
