import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { Contract } from '@super-line/core'
import type { AssembledMessageOf, ChannelRowOf, ChatClient, ChatLiveStore, MembershipRowOf } from './client.js'

export interface ChatBinding<C extends Contract> {
  /** Mount near your root with a {@link ChatClient} instance (rebuild it when the auth client swaps connections). */
  ChatProvider: (props: { chat: ChatClient<C>; children: ReactNode }) => ReactNode
  /** The chat client from context — for request methods (`send`, `join`, …). */
  useChat: () => ChatClient<C>
  /** Live channel directory (re-renders on change; the store re-subscribes on membership changes). */
  useChannels: () => ChannelRowOf<C>[]
  /** Live member list of one channel. */
  useMembers: (channelId: string) => MembershipRowOf<C>[]
  /** Live chronological message window of one channel — streamed messages arrive assembled (`parts`/`status`). */
  useMessages: (
    channelId: string,
    opts?: { limit?: number; partsLimit?: number; streaming?: boolean },
  ) => AssembledMessageOf<C>[]
}

/**
 * Build the React binding for the chat client: a provider + `useChannels`/`useMembers`/`useMessages`
 * over `useSyncExternalStore`. Each hook owns its store's lifecycle (closed on unmount / channel switch);
 * the re-subscribe-on-membership-change mechanic lives in {@link ChatClient}, not here.
 */
export function createChatHooks<C extends Contract>(): ChatBinding<C> {
  const Ctx = createContext<ChatClient<C> | null>(null)

  function ChatProvider({ chat, children }: { chat: ChatClient<C>; children: ReactNode }): ReactNode {
    return <Ctx.Provider value={chat}>{children}</Ctx.Provider>
  }

  function useChat(): ChatClient<C> {
    const chat = useContext(Ctx)
    if (!chat) throw new Error('useChat must be used inside <ChatProvider>')
    return chat
  }

  function useStoreRows<RowT>(make: () => ChatLiveStore<RowT>, deps: readonly unknown[]): RowT[] {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const store = useMemo(make, deps)
    useEffect(() => () => store.close(), [store])
    return useSyncExternalStore(store.subscribe, store.rows, store.rows)
  }

  function useChannels(): ChannelRowOf<C>[] {
    const chat = useChat()
    return useStoreRows(() => chat.channels(), [chat])
  }

  function useMembers(channelId: string): MembershipRowOf<C>[] {
    const chat = useChat()
    return useStoreRows(() => chat.members(channelId), [chat, channelId])
  }

  function useMessages(
    channelId: string,
    opts?: { limit?: number; partsLimit?: number; streaming?: boolean },
  ): AssembledMessageOf<C>[] {
    const chat = useChat()
    const limit = opts?.limit
    const partsLimit = opts?.partsLimit
    const streaming = opts?.streaming
    return useStoreRows(
      () =>
        chat.messages(channelId, {
          ...(limit !== undefined ? { limit } : {}),
          ...(partsLimit !== undefined ? { partsLimit } : {}),
          ...(streaming !== undefined ? { streaming } : {}),
        }),
      [chat, channelId, limit, partsLimit, streaming],
    )
  }

  return { ChatProvider, useChat, useChannels, useMembers, useMessages }
}
