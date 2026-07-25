// The chat hook bindings, mirroring examples/chat-supervisor/src/App.tsx. The generic super-line hooks
// (useCollection, useDoc) come straight from '@super-line/plugin-auth/react' — the auth provider feeds them.

import { chatClient } from '@super-line/plugin-chat/client'
import { createChatHooks } from '@super-line/plugin-chat/react'
import type { app } from '../contract'

export const {
  ChatProvider,
  useChat,
  useChannels,
  useMembers,
  useMessages,
  useMessageParts,
  useChannelResources,
  useResourcePresence,
} = createChatHooks<typeof app>()
export { chatClient }
