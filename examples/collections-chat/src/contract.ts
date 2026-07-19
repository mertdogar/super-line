import { z } from 'zod'
import { defineContract, type RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

/**
 * The wire contract. The durable chat model — channels, memberships, messages — comes ENTIRELY from
 * `@super-line/plugin-chat`: `chatContract()` merges those three collections and the 11 mutation
 * requests (createChannel/join/addMember/sendMessage/…) into this contract, so the server validates
 * every write and both ends share end-to-end types. Identity comes from `@super-line/plugin-auth`.
 *
 * All this app declares itself is the ephemeral, non-durable garnish that isn't rows — presence and
 * typing — proving host-land signals still compose cleanly on top of a plugin backbone.
 */
export const chat = defineContract({
  roles: {
    user: {
      clientToServer: {
        // seed the current presence list on mount (topics aren't retained)
        hello: { input: z.void(), output: z.object({ users: z.array(z.string()) }) },
        // the client pings this while typing; the server rebroadcasts per channel
        typing: { input: z.object({ channelId: z.string() }), output: z.object({ ok: z.boolean() }) },
      },
      serverToClient: {
        // who is connected right now (workspace-wide), as a sorted list of names
        presence: { payload: z.object({ users: z.array(z.string()) }), subscribe: true },
        // who is currently typing, per channel: { [channelId]: [name, ...] }
        typing: { payload: z.object({ byChannel: z.record(z.string(), z.array(z.string())) }), subscribe: true },
      },
    },
  },
  // plugin-auth: guest role + users/credentials/sessions collections + signIn/signUp/signOut/whoami.
  // plugin-chat: channels/memberships/messages collections + the chat mutation requests (default text body).
  plugins: [authContract(), chatContract()],
})

/** Typed rows, derived from the merged contract — one source of truth for server + client. */
export type User = RowOf<typeof chat, 'users'>
export type Channel = RowOf<typeof chat, 'channels'>
export type Membership = RowOf<typeof chat, 'memberships'>
export type Message = RowOf<typeof chat, 'messages'>
export type MessagePart = RowOf<typeof chat, 'messageParts'>
export type FeedMessage = Message
