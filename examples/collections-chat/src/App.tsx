import { useAuth } from '@super-line/plugin-auth/react'
import { LoginScreen } from '@/components/login-screen'
import { Workspace } from '@/components/workspace'

export function App(): React.JSX.Element {
  const { state, signOut } = useAuth()

  // Authed first: a session REPLACEMENT (reauthenticate) keeps the incumbent live with `pending` set, so
  // checking `pending` first would drop the workspace back to the splash mid-switch.
  if (state.status === 'authed') {
    return <Workspace me={state.userId!} name={state.displayName ?? state.userId!} onSignOut={signOut} />
  }
  // hold the UI until any persisted session has been confirmed, so we don't flash the login screen
  if (state.pending) {
    return <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">Connecting…</div>
  }
  return <LoginScreen />
}
