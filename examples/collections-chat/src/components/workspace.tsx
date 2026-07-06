import type { SuperLineClient } from '@super-line/client'
import { Provider } from '@/lib/superline'
import { ChatProvider } from '@/lib/chat'
import { Shell } from '@/components/shell'
import type { chat } from '@/contract'

// The authenticated workspace. The live client comes from @super-line/plugin-auth (its lifecycle — connect,
// reconnect, close on sign-out — is owned there); here we just wire it into the super-line + chat providers.
export function Workspace({
  client,
  me,
  name,
  onSignOut,
}: {
  client: SuperLineClient<typeof chat, 'user'>
  me: string
  name: string
  onSignOut: () => void
}): React.JSX.Element {
  return (
    <Provider client={client}>
      <ChatProvider me={me}>
        <Shell myName={name} onSignOut={onSignOut} />
      </ChatProvider>
    </Provider>
  )
}
