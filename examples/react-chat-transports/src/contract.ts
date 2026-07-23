import { z } from 'zod'
import { defineContract, type RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

/**
 * The whole contract. Identity comes from `@super-line/plugin-auth` (users, credentials, sessions,
 * presence + the `guest` role); the durable chat model — channels, memberships, messages — comes from
 * `@super-line/plugin-chat`. This app declares NO surface of its own: the only thing it adds is the
 * wire the browser dials over, and a transport is not contract surface.
 *
 * The `user` role is the one block that isn't a plugin: plugin-chat puts its requests on `shared` and
 * plugin-auth only contributes `guest`, so the host still names the authenticated role it connects as.
 * Its `env` (ADR-0012) is the server-vended, client-visible slice — here it carries the PUBLIC half of a
 * bearer assertion's payload, which is the only way a browser holding a *sealed* token learns what is in
 * it. The sealed half never appears here, because `env` is by definition what the client may see.
 */
export const chat = defineContract({
  roles: { user: { env: z.object({ workspace: z.string() }) } },
  plugins: [authContract(), chatContract()],
})

/** Typed rows, derived from the merged contract — one source of truth for server + client. */
export type User = RowOf<typeof chat, 'users'>
export type Channel = RowOf<typeof chat, 'channels'>
export type Membership = RowOf<typeof chat, 'memberships'>
export type Message = RowOf<typeof chat, 'messages'>
export type UserPresence = RowOf<typeof chat, 'userPresence'>
