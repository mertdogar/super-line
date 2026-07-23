import type { SuperLineClient } from '@super-line/client'
import { Provider } from '@/lib/superline'
import { ChatProvider } from '@/lib/chat'
import { Shell } from '@/components/shell'
import type { chat } from '@/contract'

// The authenticated workspace. The live client comes from @super-line/plugin-auth (its lifecycle —
// connect, swap on login/logout, close on sign-out — is owned there); here we wire it into the
// super-line + chat providers. Which wire it dialed is not visible from this file, by design.
export function Workspace({
  client,
  me,
  onSignOut,
}: {
  client: SuperLineClient<typeof chat, 'user'>
  me: string
  onSignOut: () => void
}): React.JSX.Element {
  return (
    <Provider client={client}>
      <ChatProvider client={client} me={me}>
        <Shell onSignOut={onSignOut} />
      </ChatProvider>
    </Provider>
  )
}
