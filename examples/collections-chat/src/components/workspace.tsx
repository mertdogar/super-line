import { useClient } from '@super-line/plugin-auth/react'
import { ChatProvider } from '@/lib/chat'
import { Shell } from '@/components/shell'

// The authenticated workspace. The live client comes from @super-line/plugin-auth (its lifecycle — connect,
// reconnect, close on sign-out — is owned there, and it feeds the hooks directly); here we only wire the
// chat provider, which wraps ONE connection and so takes the client explicitly.
export function Workspace({
  me,
  name,
  onSignOut,
}: {
  me: string
  name: string
  onSignOut: () => void
}): React.JSX.Element {
  // Non-null exactly while `status === 'authed'` — the provider gates it.
  const client = useClient()!
  return (
    <ChatProvider client={client} me={me}>
      <Shell myName={name} onSignOut={onSignOut} />
    </ChatProvider>
  )
}
