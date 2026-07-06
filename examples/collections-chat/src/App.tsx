import { useAuth } from '@/lib/auth'
import { LoginScreen } from '@/components/login-screen'
import { Workspace } from '@/components/workspace'

export function App(): React.JSX.Element {
  const { ready, state, client, signOut } = useAuth()

  // hold the UI until any persisted session has been confirmed, so we don't flash the login screen
  if (!ready) {
    return <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">Connecting…</div>
  }
  if (state.status !== 'authed') return <LoginScreen />

  return <Workspace client={client} me={state.userId!} name={state.displayName ?? state.userId!} onSignOut={signOut} />
}
