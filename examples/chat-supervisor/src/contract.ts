import { defineContract } from '@super-line/core'
import type { RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

/**
 * The whole app is the two plugins: identity from plugin-auth, the channel + streamed
 * agent turns from plugin-chat. The host contributes no requests of its own.
 */
export const app = defineContract({
  roles: { user: {}, guest: {} },
  plugins: [authContract(), chatContract()],
})

export type User = RowOf<typeof app, 'users'>
export type Message = RowOf<typeof app, 'messages'>
export type MessagePart = RowOf<typeof app, 'messageParts'>
/** A message as the assembled feed serves it: streamed turns carry live `parts` (+ `status`). */
export type FeedMessage = Message & { parts?: MessagePart[] }
