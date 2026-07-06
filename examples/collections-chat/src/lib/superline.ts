import { createSuperLineHooks } from '@super-line/react'
import type { chat } from '@/contract'

// Typed hooks bound to the chat contract + the single `user` role. Durable state (users/channels/
// messages/memberships) flows through TanStack DB collections (see lib/chat.tsx); these hooks carry
// only the ephemeral presence/typing signals + `useClient` for the collection wiring.
export const { Provider, useClient, useRequest, useSubscription } = createSuperLineHooks<
  typeof chat,
  'user'
>()
