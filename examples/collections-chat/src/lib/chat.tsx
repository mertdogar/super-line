import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { createCollection } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { isIn, SuperLineError } from '@super-line/core'
import type { SuperLineClient } from '@super-line/client'
import { superLineCollectionOptions } from '@super-line/tanstack-db'
import { chat, type Membership } from '@/contract'
import { memId, slug } from '@/lib/identity'
import { useClient } from '@/lib/superline'

type Client = SuperLineClient<typeof chat, 'user'>

// Small typed factories: one super-line-backed TanStack DB collection each. Using `ReturnType` for the
// context field types keeps them exactly what `createCollection` infers (no generic-assignability dance).
const usersCollection = (client: Client) => createCollection(superLineCollectionOptions(client, chat, 'users'))
const channelsCollection = (client: Client) => createCollection(superLineCollectionOptions(client, chat, 'channels'))
const membershipsCollection = (client: Client) =>
  createCollection(superLineCollectionOptions(client, chat, 'memberships'))
const messagesCollection = (client: Client, channelIds: string[]) => {
  const config = superLineCollectionOptions(client, chat, 'messages', { query: { filter: isIn('channelId', channelIds) } })
  // This collection is re-created whenever the joined-channel set changes (see ChatProvider). Give each
  // instance a distinct id — two collections sharing the adapter's default `superline:messages` would
  // collide in TanStack's registry during the swap.
  return createCollection({ ...config, id: `superline:messages:${channelIds.join(',') || 'none'}` })
}

export interface ChatApi {
  /** my user id (= slug of my display name) — the principal every row policy checks */
  me: string
  users: ReturnType<typeof usersCollection>
  channels: ReturnType<typeof channelsCollection>
  memberships: ReturnType<typeof membershipsCollection>
  messages: ReturnType<typeof messagesCollection>
  /** the channels I've joined, from my CONFIRMED membership rows */
  myChannelIds: string[]
  /** post a message optimistically (author-only write policy rolls it back if I cheat) */
  send: (channelId: string, text: string) => void
  /** create a channel and join it; returns the channel id */
  createChannel: (name: string) => Promise<string>
  join: (channelId: string) => Promise<void>
  leave: (channelId: string) => Promise<void>
}

const ChatContext = createContext<ChatApi | null>(null)

export function useChat(): ChatApi {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used inside <ChatProvider>')
  return ctx
}

const isConflict = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string } | undefined
  return e?.code === 'CONFLICT' || /CONFLICT/i.test(e?.message ?? String(err))
}

export function ChatProvider({ me, children }: { me: string; children: ReactNode }): React.JSX.Element {
  const client = useClient()

  // World-readable directories + my own membership rows. Stable for the life of the connection.
  const users = useMemo(() => usersCollection(client), [client])
  const channels = useMemo(() => channelsCollection(client), [client])
  const memberships = useMemo(() => membershipsCollection(client), [client])

  // My joined channels, from CONFIRMED membership rows. Join/leave write memberships NON-optimistically
  // (below), so this set only moves once the server agrees — which is what keeps the messages
  // re-subscribe below from ever racing ahead of the row policy.
  const { data: myRows } = useLiveQuery((q) => q.from({ m: memberships }))
  const myChannelIds = useMemo(
    () => (myRows as Membership[]).map((m) => m.channelId).sort(),
    [myRows],
  )
  const channelKey = myChannelIds.join(',')

  // Re-created whenever my channel set changes. A fresh subscription makes the server re-evaluate the async
  // messages read policy against my current membership, streaming in a just-joined channel's backlog (and
  // dropping a left one's). The server enforces the same policy — this client filter just drives the re-sub.
  const messages = useMemo(
    () => messagesCollection(client, myChannelIds),
    // channelKey stands in for myChannelIds (a fresh array each render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, channelKey],
  )
  useEffect(() => () => void messages.cleanup(), [messages]) // stop the old subscription on re-key / unmount

  const value = useMemo<ChatApi>(() => {
    const join = async (channelId: string): Promise<void> => {
      // non-optimistic: the row shows only once confirmed — see myChannelIds above
      await memberships
        .insert({ id: memId(me, channelId), userId: me, channelId }, { optimistic: false })
        .isPersisted.promise
    }
    const leave = async (channelId: string): Promise<void> => {
      await memberships.delete(memId(me, channelId), { optimistic: false }).isPersisted.promise
    }

    const send = (channelId: string, text: string): void => {
      const body = text.trim()
      if (!body) return
      // optimistic: shows instantly, then persists + syncs back through the author join
      void messages
        .insert({ id: crypto.randomUUID(), channelId, authorId: me, text: body, createdAt: Date.now() })
        .isPersisted.promise.catch(() => {})
    }

    const createChannel = async (name: string): Promise<string> => {
      const id = slug(name)
      if (!id) throw new SuperLineError('BAD_REQUEST', 'channel name is empty')
      try {
        await channels.insert({ id, name: name.trim(), createdAt: Date.now() }).isPersisted.promise
      } catch (err) {
        if (!isConflict(err)) throw err // already exists → fall through and just join it
      }
      await join(id)
      return id
    }

    return { me, users, channels, memberships, messages, myChannelIds, send, createChannel, join, leave }
  }, [me, users, channels, memberships, messages, myChannelIds])

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}
