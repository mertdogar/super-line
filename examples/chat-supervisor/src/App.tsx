import { ChatProvider, useChat as useMaybeChat } from '@super-line/plugin-chat/react'
import type { ChatClient } from '@super-line/plugin-chat/client'
import { useAuth } from '@super-line/plugin-auth/react'
import { Login } from '@/components/login'
import { Chat } from '@/components/chat'
import type { app } from '@/contract'

// The registered module-level chat binding, re-exported so components have one local import site.
export {
  useChannels,
  useMessages,
  useMessageParts,
  useChatHistory,
  useChannelResources,
  useResourcePresence,
} from '@super-line/plugin-chat/react'

/** The chat client for request methods. Panes only mount inside the authed provider, so a missing client is a wiring bug — throw, don't null-check at every call site. */
export function useChat(): ChatClient<typeof app> {
  const chat = useMaybeChat()
  if (!chat) throw new Error('useChat outside the authed <ChatProvider> subtree')
  return chat
}

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
  // The provider AUTO-BUILDS its chatClient from the shared context and rebuilds it per session —
  // the useMemo(chatClient) + close-effect dance this file used to carry is the library's job now.
  return (
    <ChatProvider>
      <Chat me={me} myName={name} onSignOut={onSignOut} />
    </ChatProvider>
  )
}
