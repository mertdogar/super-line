import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { eq, type CollectionQuery } from '@super-line/core'
import type { SuperLineClient } from '@super-line/client'
import { chatClient, type ChatClient } from '@super-line/plugin-chat/client'
import { createChatHooks } from '@super-line/plugin-chat/react'
import { chat, type Membership, type User } from '@/contract'

type Client = SuperLineClient<typeof chat, 'user'>

// The plugin's React binding — `useChannels`/`useMembers`/`useMessages` over the chatClient (which owns
// the membership-driven re-subscribe mechanic) + `useChat()` for the request methods (send/join/…).
const binding = createChatHooks<typeof chat>()
export const { useChat, useChannels, useMembers, useMessages, useMessageParts, useChatHistory } = binding

// A tiny reactive view over any raw client collection — for the app-specific reads the chat plugin
// doesn't wrap: the world-readable `users` directory (author names) and my own membership rows.
function useLiveRows<Row>(client: Client, name: 'users' | 'memberships', query: CollectionQuery): Row[] {
  const sub = useMemo(() => client.collection(name).subscribe(query) as { rows(): unknown; subscribe(cb: () => void): () => void; close(): void }, [client, name, query])
  useEffect(() => () => sub.close(), [sub])
  return useSyncExternalStore(sub.subscribe, () => sub.rows() as Row[], () => sub.rows() as Row[])
}

interface ChatExtra {
  me: string
  /** userId → user row, from the public directory (for author names + deactivated badges). */
  users: Map<string, User>
  /** my membership rows across all channels (own rows are a STABLE read filter — never goes deaf). */
  myMemberships: Membership[]
}
const ExtraCtx = createContext<ChatExtra | null>(null)
const EMPTY_QUERY: CollectionQuery = {}

/**
 * Wire the plugin chat client into React and add two app-level reads (users directory + my memberships).
 * Rebuild it whenever the underlying super-line client swaps (login/logout) — the chatClient wraps ONE
 * connection.
 */
export function ChatProvider({ client, me, children }: { client: Client; me: string; children: ReactNode }): ReactNode {
  const chatCli = useMemo<ChatClient<typeof chat>>(() => chatClient(client, { userId: me }), [client, me])
  useEffect(() => () => chatCli.close(), [chatCli])

  const users = useLiveRows<User>(client, 'users', EMPTY_QUERY)
  const myFilter = useMemo<CollectionQuery>(() => ({ filter: eq('userId', me) }), [me])
  const myMemberships = useLiveRows<Membership>(client, 'memberships', myFilter)

  const usersMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const extra = useMemo<ChatExtra>(() => ({ me, users: usersMap, myMemberships }), [me, usersMap, myMemberships])

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

/** My membership role in a channel, or undefined if I'm not a member. */
export function useMyRole(channelId: string): Membership['role'] | undefined {
  const mine = useMyMemberships()
  return mine.find((m) => m.channelId === channelId)?.role
}
