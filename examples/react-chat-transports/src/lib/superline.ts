import { createSuperLineHooks } from '@super-line/react'
import type { chat } from '@/contract'

// Typed hooks bound to the chat contract + the single `user` role. This app declares no requests,
// events or topics of its own — everything durable flows through the plugins' collections — so only
// `Provider` and `useClient` are used here.
export const { Provider, useClient } = createSuperLineHooks<typeof chat, 'user'>()
