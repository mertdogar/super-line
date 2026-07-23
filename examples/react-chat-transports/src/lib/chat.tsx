import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { eq, type CollectionQuery } from '@super-line/core'
import type { SuperLineClient } from '@super-line/client'
import { USER_PRESENCE_LIVE_MS } from '@super-line/plugin-auth'
import { chatClient, type ChatClient } from '@super-line/plugin-chat/client'
import { createChatHooks } from '@super-line/plugin-chat/react'
import { chat, type Membership, type User, type UserPresence } from '@/contract'

type Client = SuperLineClient<typeof chat, 'user'>

// The plugin's React binding — `useChannels`/`useMembers`/`useMessages` over the chatClient (which owns
// the membership-driven re-subscribe mechanic) + `useChat()` for the request methods (send/join/…).
const binding = createChatHooks<typeof chat>()
export const { useChat, useChannels, useMembers, useMessages } = binding

// A tiny reactive view over a raw client collection — for the reads the chat plugin doesn't wrap:
// plugin-auth's world-readable `users` directory and `userPresence`, plus my own membership rows.
function useLiveRows<Row>(client: Client, name: 'users' | 'memberships' | 'userPresence', query: CollectionQuery): Row[] {
  const sub = useMemo(
    () =>
      client.collection(name).subscribe(query) as {
        rows(): unknown
        subscribe(cb: () => void): () => void
        close(): void
      },
    [client, name, query],
  )
  useEffect(() => () => sub.close(), [sub])
  return useSyncExternalStore(
    sub.subscribe,
    () => sub.rows() as Row[],
    () => sub.rows() as Row[],
  )
}

interface ChatExtra {
  me: string
  /** userId → user row, from the public directory (author names + deactivated badges). */
  users: Map<string, User>
  /** my membership rows across all channels (own rows are a STABLE read filter — never goes deaf). */
  myMemberships: Membership[]
  /** userIds with at least one live connection right now, straight from plugin-auth. */
  online: Set<string>
}
const ExtraCtx = createContext<ChatExtra | null>(null)
const EMPTY_QUERY: CollectionQuery = {}

/**
 * Wire the plugin chat client into React and add the app-level reads (users directory, live presence,
 * my memberships). Rebuild it whenever the underlying super-line client swaps (login/logout) — the
 * chatClient wraps ONE connection.
 */
export function ChatProvider({ client, me, children }: { client: Client; me: string; children: ReactNode }): ReactNode {
  const chatCli = useMemo<ChatClient<typeof chat>>(() => chatClient(client, { userId: me }), [client, me])
  useEffect(() => () => chatCli.close(), [chatCli])

  const users = useLiveRows<User>(client, 'users', EMPTY_QUERY)
  const myFilter = useMemo<CollectionQuery>(() => ({ filter: eq('userId', me) }), [me])
  const myMemberships = useLiveRows<Membership>(client, 'memberships', myFilter)
  // Presence needs no app code at all: plugin-auth derives these rows from real connection sessions,
  // so "who's online" is the same on every wire. A row is live while it has an open session AND a
  // recent heartbeat (a node that died without cleanup ages out).
  const presence = useLiveRows<UserPresence>(client, 'userPresence', EMPTY_QUERY)
  const online = useMemo(() => {
    const cutoff = Date.now() - USER_PRESENCE_LIVE_MS
    return new Set(presence.filter((p) => p.connectedAt !== null && (p.lastSeenAt ?? 0) > cutoff).map((p) => p.userId))
  }, [presence])

  const usersMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const extra = useMemo<ChatExtra>(() => ({ me, users: usersMap, myMemberships, online }), [me, usersMap, myMemberships, online])

  return (
    <binding.ChatProvider chat={chatCli}>
      <ExtraCtx.Provider value={extra}>{children}</ExtraCtx.Provider>
    </binding.ChatProvider>
  )
}

function useExtra(): ChatExtra {
  const ctx = useContext(ExtraCtx)
  if (!ctx) throw new Error('useExtra must be used inside <ChatProvider>')
  return ctx
}

export const useMe = (): string => useExtra().me
export const useUsers = (): Map<string, User> => useExtra().users
export const useMyMemberships = (): Membership[] => useExtra().myMemberships
export const useOnline = (): Set<string> => useExtra().online

/** My membership role in a channel, or undefined if I'm not a member. */
export function useMyRole(channelId: string): Membership['role'] | undefined {
  const mine = useMyMemberships()
  return mine.find((m) => m.channelId === channelId)?.role
}
