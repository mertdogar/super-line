import { createSuperLineHooks } from '@super-line/react'
import type { chat } from '@/contract'

// Typed hooks bound to the chat contract + the single `user` role.
export const { Provider, useRequest, useEvent, useSubscription, useResource } = createSuperLineHooks<
  typeof chat,
  'user'
>()
