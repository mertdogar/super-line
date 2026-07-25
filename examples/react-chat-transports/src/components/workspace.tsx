import { useClient } from '@super-line/plugin-auth/react'
import { ChatProvider } from '@/lib/chat'
import { BearerBanner } from '@/components/bearer-banner'
import { Shell } from '@/components/shell'
import type { BearerInfo } from '@/lib/jwt'

// The authenticated workspace. The live client comes from the NEAREST <SuperLineAuthProvider> — the app-wide
// one for a password session, or the nested bearer one in components/jwt-session.tsx. Neither which wire it
// dialed nor which credential opened it is visible below this file: the workspace just gets on with it.
export function Workspace({
  me,
  onSignOut,
  bearer,
}: {
  me: string
  onSignOut: () => void
  /** Present only for a JWT-authenticated connection — see components/jwt-session.tsx. */
  bearer?: BearerInfo
}): React.JSX.Element {
  // Non-null exactly while `status === 'authed'` — the provider gates it.
  const client = useClient()!
  return (
    <>
      <ChatProvider client={client} me={me}>
        <div className="flex h-full flex-col">
          {bearer && <BearerBanner bearer={bearer} onExit={onSignOut} />}
          <div className="min-h-0 flex-1">
            <Shell onSignOut={onSignOut} />
          </div>
        </div>
      </ChatProvider>
    </>
  )
}
