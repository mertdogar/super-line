import { z } from 'zod'
import { defineContract, type RowOf } from '@super-line/core'

/**
 * The wire contract. Unlike the store-based `advanced-chat-app`, the durable state here lives in typed
 * COLLECTIONS declared on the contract (ADR-0006): the server validates every row write and both ends
 * share end-to-end types. super-line is the server-authoritative sync source; TanStack DB is the client
 * query engine (joins + optimistic mutations). Row-level security lives in the server's `policies`.
 *
 * Four collections model the whole app — no `send`/`createChannel` requests: those are optimistic row
 * writes now. Only the ephemeral `presence`/`typing` signals stay as requests + topics (they aren't rows).
 */
export const chat = defineContract({
  collections: {
    // The user directory. World-readable (needed for the messages⋈users author join); the server
    // upserts your row on connect, so clients never write it.
    users: {
      schema: z.object({ id: z.string(), name: z.string() }),
      key: 'id',
    },
    // The public channel directory — every channel is visible so you can discover + join it.
    channels: {
      schema: z.object({ id: z.string(), name: z.string(), createdAt: z.number() }),
      key: 'id',
    },
    // Which channels a user has joined. Read-your-own + write-your-own (self-service join/leave). The
    // messages read policy resolves your visible channels from these rows.
    memberships: {
      schema: z.object({ id: z.string(), userId: z.string(), channelId: z.string() }),
      key: 'id',
      references: { userId: 'users', channelId: 'channels' },
    },
    // The messages. Read is row-level-secured to your joined channels; write is author-only.
    messages: {
      schema: z.object({
        id: z.string(),
        channelId: z.string(),
        authorId: z.string(),
        text: z.string(),
        createdAt: z.number(),
      }),
      key: 'id',
      references: { authorId: 'users', channelId: 'channels' },
    },
  },
  roles: {
    user: {
      clientToServer: {
        // called once on mount to seed the current presence list (topics aren't retained, so a
        // late subscriber would otherwise miss the current value until the next change)
        hello: { input: z.void(), output: z.object({ users: z.array(z.string()) }) },
        // fire-and-forget-ish: the client pings this while typing; the server rebroadcasts.
        typing: {
          input: z.object({ channel: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
      serverToClient: {
        // who is connected right now (workspace-wide), as a sorted list of names
        presence: { payload: z.object({ users: z.array(z.string()) }), subscribe: true },
        // who is currently typing, per channel: { [channelId]: [name, ...] }
        typing: {
          payload: z.object({ byChannel: z.record(z.string(), z.array(z.string())) }),
          subscribe: true,
        },
      },
    },
  },
})

/** Typed rows, derived from the contract collections — one source of truth for server + client. */
export type User = RowOf<typeof chat, 'users'>
export type Channel = RowOf<typeof chat, 'channels'>
export type Membership = RowOf<typeof chat, 'memberships'>
export type Message = RowOf<typeof chat, 'messages'>
