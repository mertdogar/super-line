import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { eq } from '@super-line/core'
import { useCollection } from '@super-line/react'
import { ChatProvider as PluginChatProvider, useChat as useMaybeChat } from '@super-line/plugin-chat/react'
import type { ChatClient } from '@super-line/plugin-chat/client'
import type { chat, Membership, User } from '@/contract'

// The plugin's registered module-level hooks, re-exported so components have one import site beside
// the app-level extras below.
export { useChannels, useMembers, useMessages, useMessageParts, useChatHistory } from '@super-line/plugin-chat/react'

/** The chat client for request methods (send/join/…). Panes only mount inside the authed provider, so a missing client is a wiring bug — throw, don't null-check at every call site. */
export function useChat(): ChatClient<typeof chat> {
  const chatCli = useMaybeChat()
  if (!chatCli) throw new Error('useChat outside the authed <ChatProvider> subtree')
  return chatCli
}

interface ChatExtra {
  me: string
  /** userId → user row, from the public directory (for author names + deactivated badges). */
  users: Map<string, User>
  /** my membership rows across all channels (own rows are a STABLE read filter — never goes deaf). */
  myMemberships: Membership[]
}
const ExtraCtx = createContext<ChatExtra | null>(null)

/**
 * App-level chat wiring. The plugin's ChatProvider AUTO-BUILDS its chatClient from the shared context
 * (rebuilding on session swap) — nothing to construct here; the app only adds its own reads (users
 * directory + my memberships) over the registered `useCollection`.
 */
export function ChatProvider({ me, children }: { me: string; children: ReactNode }): ReactNode {
  const { rows: users } = useCollection('users')
  const myQuery = useMemo(() => ({ filter: eq('userId', me) }), [me])
  const { rows: myMemberships } = useCollection('memberships', myQuery)

  const usersMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users])
  const extra = useMemo<ChatExtra>(() => ({ me, users: usersMap, myMemberships }), [me, usersMap, myMemberships])

  return (
    <PluginChatProvider>
      <ExtraCtx.Provider value={extra}>{children}</ExtraCtx.Provider>
    </PluginChatProvider>
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
