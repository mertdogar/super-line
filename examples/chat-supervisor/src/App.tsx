import { useEffect, useMemo } from 'react'
import { chatClient } from '@super-line/plugin-chat/client'
import { createChatHooks } from '@super-line/plugin-chat/react'
import { useAuth } from '@/lib/auth'
import { Login } from '@/components/login'
import { Chat } from '@/components/chat'
import { app } from '@/contract'

export const { ChatProvider, useChat, useChannels, useMessages } = createChatHooks<typeof app>()

export function App(): React.JSX.Element {
  const { ready, state, client, signOut } = useAuth()

  if (!ready) {
    return <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">Connecting…</div>
  }
  if (state.status !== 'authed') return <Login />
  return <Authed client={client} me={state.userId!} name={state.displayName ?? state.userId!} onSignOut={signOut} />
}

function Authed({
  client,
  me,
  name,
  onSignOut,
}: {
  client: Parameters<typeof chatClient<typeof app, 'user'>>[0]
  me: string
  name: string
  onSignOut: () => void
}): React.JSX.Element {
  const chat = useMemo(() => chatClient<typeof app, 'user'>(client, { userId: me }), [client, me])
  useEffect(() => () => chat.close(), [chat])
  return (
    <ChatProvider chat={chat}>
      <Chat me={me} myName={name} onSignOut={onSignOut} />
    </ChatProvider>
  )
}
