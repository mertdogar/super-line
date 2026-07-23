import type { SuperLineClient } from '@super-line/client'
import { Provider } from '@/lib/superline'
import { ChatProvider } from '@/lib/chat'
import { BearerBanner } from '@/components/bearer-banner'
import { Shell } from '@/components/shell'
import type { chat } from '@/contract'
import type { BearerInfo } from '@/lib/jwt'

// The authenticated workspace. The live client usually comes from @super-line/plugin-auth (its
// lifecycle — connect, swap on login/logout, close on sign-out — is owned there), or from a bearer
// JWT handoff. Neither which wire it dialed nor which credential opened it is visible below this
// file: the workspace is handed a connected client and gets on with it.
export function Workspace({
  client,
  me,
  onSignOut,
  bearer,
}: {
  client: SuperLineClient<typeof chat, 'user'>
  me: string
  onSignOut: () => void
  /** Present only for a JWT-authenticated connection — see components/jwt-session.tsx. */
  bearer?: BearerInfo
}): React.JSX.Element {
  return (
    <Provider client={client}>
      <ChatProvider client={client} me={me}>
        <div className="flex h-full flex-col">
          {bearer && <BearerBanner bearer={bearer} onExit={onSignOut} />}
          <div className="min-h-0 flex-1">
            <Shell onSignOut={onSignOut} />
          </div>
        </div>
      </ChatProvider>
    </Provider>
  )
}
