import { useEffect, useMemo } from 'react'
import { chatClient } from '@super-line/plugin-chat/client'
import { createChatHooks } from '@super-line/plugin-chat/react'
import { useAuth, useClient } from '@super-line/plugin-auth/react'
import { Login } from '@/components/login'
import { Chat } from '@/components/chat'
import { app } from '@/contract'

export const {
  ChatProvider,
  useChat,
  useChannels,
  useMessages,
  useMessageParts,
  useChatHistory,
  useChannelResources,
  useResourcePresence,
} = createChatHooks<typeof app>()

export function App(): React.JSX.Element {
  const { state, signOut } = useAuth()

  // Authed first: a session REPLACEMENT (reauthenticate) keeps the incumbent live with `pending` set, so
  // checking `pending` before `status` would tear the whole cockpit down mid-switch.
  if (state.status === 'authed') {
    return <Authed me={state.userId!} name={state.displayName ?? state.userId!} onSignOut={signOut} />
  }
  if (state.pending) {
    return <div className="flex h-full items-center justify-center bg-sidebar text-muted-foreground">Connecting…</div>
  }
  return <Login />
}

function Authed({ me, name, onSignOut }: { me: string; name: string; onSignOut: () => void }): React.JSX.Element {
  // Non-null exactly while `status === 'authed'` — the provider gates it, so there is no null branch here.
  const client = useClient()!
  const chat = useMemo(() => chatClient<typeof app, 'user'>(client, { userId: me }), [client, me])
  useEffect(() => () => chat.close(), [chat])
  return (
    <ChatProvider chat={chat}>
      <Chat me={me} myName={name} onSignOut={onSignOut} />
    </ChatProvider>
  )
}
