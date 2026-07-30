import { ChatProvider } from '@/lib/chat'
import { Shell } from '@/components/shell'

// The authenticated workspace. The session's client lives in the SHARED @super-line/react context (fed by
// SuperLineAuthProvider), and the chat provider auto-builds its chatClient from it — nothing to wire here.
export function Workspace({
  me,
  name,
  onSignOut,
}: {
  me: string
  name: string
  onSignOut: () => void
}): React.JSX.Element {
  return (
    <ChatProvider me={me}>
      <Shell myName={name} onSignOut={onSignOut} />
    </ChatProvider>
  )
}
