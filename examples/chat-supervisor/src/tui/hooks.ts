// The react hook bindings, mirroring examples/chat-supervisor/src/App.tsx: chat hooks from
// plugin-chat/react + the generic super-line hooks (useCollection carries the users directory).

import { chatClient } from '@super-line/plugin-chat/client'
import { createChatHooks } from '@super-line/plugin-chat/react'
import { createSuperLineHooks } from '@super-line/react'
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
export const { Provider: LineProvider, useCollection } = createSuperLineHooks<typeof app, 'user'>()
export { chatClient }
