import { z } from 'zod'
import { defineContract } from '@super-line/core'

/**
 * The wire contract. Channels and message history are NOT here — they live off-contract in a
 * Store (the `chat` namespace, persisted by store-sqlite on the server, read live by the client
 * via `useResource`). The contract only carries the server-authoritative WRITES (createChannel,
 * send) plus the ephemeral presence/typing topics.
 */
export const chat = defineContract({
  roles: {
    user: {
      clientToServer: {
        // called once on mount to seed the current presence list (topics aren't retained, so a
        // late subscriber would otherwise miss the current value until the next change)
        hello: { input: z.void(), output: z.object({ users: z.array(z.string()) }) },
        createChannel: {
          input: z.object({ name: z.string() }),
          output: z.object({ id: z.string() }),
        },
        send: {
          input: z.object({ channel: z.string(), text: z.string() }),
          output: z.object({ id: z.string() }),
        },
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

/** A channel as stored in the `channels` index Resource. */
export interface Channel {
  id: string
  name: string
  createdAt: number
}

/** The `channels` index Resource shape. */
export interface ChannelsDoc {
  channels: Channel[]
}

/** A single chat message. */
export interface Message {
  id: string
  from: string
  text: string
  at: number
}

/** A `messages:<channelId>` Resource shape. */
export interface MessagesDoc {
  items: Message[]
}
