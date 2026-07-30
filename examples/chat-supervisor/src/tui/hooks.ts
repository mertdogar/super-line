// App-local alias of the registered module-level chat binding, mirroring examples/chat-supervisor/src/App.tsx.
// The generic super-line hooks (useCollection, useDoc) come straight from '@super-line/react' — the auth
// provider feeds the one shared context both bindings read.

import { useChat as useMaybeChat } from '@super-line/plugin-chat/react'
import { chatClient, type ChatClient } from '@super-line/plugin-chat/client'
import type { app } from '../contract'

export {
  ChatProvider,
  useChannels,
  useMembers,
  useMessages,
  useMessageParts,
  useChannelResources,
  useResourcePresence,
} from '@super-line/plugin-chat/react'
export { chatClient }

/** The chat client for request methods. Panes only mount inside the authed provider, so a missing client is a wiring bug — throw, don't null-check at every call site. */
export function useChat(): ChatClient<typeof app> {
  const chat = useMaybeChat()
  if (!chat) throw new Error('useChat outside the authed <ChatProvider> subtree')
  return chat
}
