import { useEffect, useState } from 'react'
import { useAuth } from '@super-line/plugin-auth/react'
import { JwtSession } from '@/components/jwt-session'
import { LoginScreen } from '@/components/login-screen'
import { Workspace } from '@/components/workspace'
import { jwtFromUrl, stripJwtFromUrl } from '@/lib/jwt'
import { kind, TRANSPORT_LABELS } from '@/lib/transport'

export function App(): React.JSX.Element {
  const { state, signOut } = useAuth()
  // A bearer token this tab was handed — from `?jwt=` at load, or pasted on the login screen. It takes
  // precedence over the stored access token, so a handoff link opens a session of its own.
  const [bearer, setBearer] = useState<string | null>(jwtFromUrl)

  // Clean the credential out of the address bar immediately; `jwtFromUrl` captured it at module scope.
  useEffect(stripJwtFromUrl, [])

  // The app-wide session stays idle behind this branch — that lifecycle is plugin-auth's, not ours to
  // interrupt, and a guest connection records no session row. `key` rebuilds on a new token.
  if (bearer) return <JwtSession key={bearer} token={bearer} onExit={() => setBearer(null)} />

  // Authed first: a session REPLACEMENT keeps the incumbent live with `pending` set, so checking `pending`
  // first would flash the splash mid-switch.
  if (state.status === 'authed') return <Workspace me={state.userId!} onSignOut={signOut} />
  // hold the UI until any persisted session has been confirmed, so we don't flash the login screen
  if (state.pending) {
    return (
      <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">
        Connecting over {TRANSPORT_LABELS[kind]}…
      </div>
    )
  }
  return <LoginScreen onBearer={setBearer} />
}
