import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { Contract } from '@super-line/core'
import { PRESENCE_LIVE_MS } from './index.js'
import type {
  ChannelRowOf,
  ChatClient,
  ChatLiveStore,
  HistoryCursor,
  MessagePartRowOf,
  MessageRowOf,
  MembershipRowOf,
  ResourcePresenceRowOf,
  ResourceRowOf,
} from './client.js'

export interface ChatHistoryResult<Message> {
  messages: Message[]
  loadOlder(): Promise<void>
  hasOlder: boolean
  loading: boolean
  error: unknown
}

export interface ChatBinding<C extends Contract> {
  /** Mount near your root with a {@link ChatClient} instance (rebuild it when the auth client swaps connections). */
  ChatProvider: (props: { chat: ChatClient<C>; children: ReactNode }) => ReactNode
  /** The chat client from context — for request methods (`send`, `join`, …). */
  useChat: () => ChatClient<C>
  /** Live channel directory (re-renders on change; the store re-subscribes on membership changes). */
  useChannels: () => ChannelRowOf<C>[]
  /** Live member list of one channel. `null`/`undefined` channel = the idle state: `[]`, no subscription. */
  useMembers: (channelId: string | null | undefined) => MembershipRowOf<C>[]
  /** Live chronological newest-N message envelopes for one channel. `null`/`undefined` channel = the idle state: `[]`, no subscription. */
  useMessages: (channelId: string | null | undefined, opts?: { limit?: number }) => MessageRowOf<C>[]
  /**
   * Live durable parts for one message. Mount this only while that message needs detailed
   * rendering. `null`/`undefined` for either id = the idle state: `[]`, no subscription.
   */
  useMessageParts: (channelId: string | null | undefined, messageId: string | null | undefined) => MessagePartRowOf<C>[]
  /** The signed-in user: `userId` (null for guests / until resolved) and whether the client's `ready` handshake has landed. */
  useMe: () => { userId: string | null; ready: boolean }
  /**
   * The turn-in-flight signal: true while ANY message in the channel is still `streaming`.
   * Null-tolerant. Derive a custom variant (e.g. bot turns only) from `useMessages` directly.
   */
  useChannelBusy: (channelId: string | null | undefined) => boolean
  /** A live recent window plus explicit keyset pagination for older message envelopes. */
  useChatHistory: (channelId: string, opts?: { liveLimit?: number; pageSize?: number }) => ChatHistoryResult<MessageRowOf<C>>
  /** Live resource registry of one channel (null-tolerant). Open a row's doc with `@super-line/react`'s own `useDoc(row.collection, row.docId)`. */
  useChannelResources: (channelId: string | null | undefined) => ResourceRowOf<C>[]
  /**
   * Who's-open presence on one resource: announces open on mount, heartbeats every 20s, closes on
   * unmount, and returns the LIVE rows (recency-filtered; a crashed peer's row drops on the next
   * store change or sweep). Pass the registry row (or any `{ kind, collection, docId }`).
   */
  useResourcePresence: (row: { kind: string; collection: string; docId: string }) => ResourcePresenceRowOf<C>[]
}

/**
 * Build the React binding for the chat client: a provider + collection hooks
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

  const NO_ROWS: never[] = []

  /**
   * Store lifecycle lives in a COMMITTED effect, never in render: a store minted during render is
   * orphaned when React discards that render (StrictMode double-invoke, concurrent interruptions),
   * and a render-memoized store closed by a StrictMode remount leaves the hook subscribed to a dead
   * store. `make: null` = the null-tolerant idle state (no store, stable empty rows).
   */
  function useStoreRows<RowT>(make: (() => ChatLiveStore<RowT>) | null, deps: readonly unknown[]): RowT[] {
    const [store, setStore] = useState<ChatLiveStore<RowT> | null>(null)
    useEffect(() => {
      if (!make) {
        setStore(null)
        return
      }
      const next = make()
      setStore(next)
      return () => {
        next.close()
        setStore((current) => (current === next ? null : current))
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : () => {}), [store])
    const rows = useCallback(() => (store ? store.rows() : (NO_ROWS as RowT[])), [store])
    return useSyncExternalStore(subscribe, rows, rows)
  }

  function useChannels(): ChannelRowOf<C>[] {
    const chat = useChat()
    return useStoreRows(() => chat.channels(), [chat])
  }

  function useMembers(channelId: string | null | undefined): MembershipRowOf<C>[] {
    const chat = useChat()
    return useStoreRows(channelId == null ? null : () => chat.members(channelId), [chat, channelId])
  }

  function useMessages(channelId: string | null | undefined, opts?: { limit?: number }): MessageRowOf<C>[] {
    const chat = useChat()
    const limit = opts?.limit
    return useStoreRows(
      channelId == null ? null : () => chat.messages(channelId, limit === undefined ? undefined : { limit }),
      [chat, channelId, limit],
    )
  }

  function useMessageParts(
    channelId: string | null | undefined,
    messageId: string | null | undefined,
  ): MessagePartRowOf<C>[] {
    const chat = useChat()
    return useStoreRows(
      channelId == null || messageId == null ? null : () => chat.messageParts(channelId, messageId),
      [chat, channelId, messageId],
    )
  }

  function useMe(): { userId: string | null; ready: boolean } {
    const chat = useChat()
    const [me, setMe] = useState<{ userId: string | null; ready: boolean }>(() => ({
      userId: chat.userId,
      ready: false,
    }))
    useEffect(() => {
      let live = true
      setMe({ userId: chat.userId, ready: false })
      chat.ready.then(
        () => live && setMe({ userId: chat.userId, ready: true }),
        () => {},
      )
      return () => {
        live = false
      }
    }, [chat])
    return me
  }

  function useChannelBusy(channelId: string | null | undefined): boolean {
    const messages = useMessages(channelId)
    return messages.some((message) => (message as { status?: string }).status === 'streaming')
  }

  function useChatHistory(
    channelId: string,
    opts?: { liveLimit?: number; pageSize?: number },
  ): ChatHistoryResult<MessageRowOf<C>> {
    const chat = useChat()
    const liveLimit = opts?.liveLimit
    const pageSize = opts?.pageSize ?? 50
    const live = useMessages(channelId, liveLimit === undefined ? undefined : { limit: liveLimit })
    const [older, setOlder] = useState<MessageRowOf<C>[]>([])
    const [cursor, setCursor] = useState<HistoryCursor>()
    const [hasOlder, setHasOlder] = useState(true)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<unknown>()
    const position = (message: MessageRowOf<C>): { id: string; createdAt: number } =>
      message as unknown as { id: string; createdAt: number }

    useEffect(() => {
      setOlder([])
      setCursor(undefined)
      setHasOlder(true)
      setLoading(false)
      setError(undefined)
    }, [chat, channelId, pageSize, liveLimit])

    const oldestLive = live[0] as (MessageRowOf<C> & { createdAt: number; id: string }) | undefined
    const loadOlder = useCallback(async (): Promise<void> => {
      if (loading || !hasOlder) return
      const before = cursor ?? (oldestLive ? { createdAt: oldestLive.createdAt, id: oldestLive.id } : undefined)
      if (!before) {
        setHasOlder(false)
        return
      }
      setLoading(true)
      setError(undefined)
      try {
        const page = await chat.history(channelId, { before, limit: pageSize })
        setOlder((current) => {
          const byId = new Map([...page.messages, ...current].map((message) => [position(message).id, message]))
          return [...byId.values()].sort(
            (a, b) =>
              position(a).createdAt - position(b).createdAt || position(a).id.localeCompare(position(b).id),
          )
        })
        setCursor(page.nextCursor)
        setHasOlder(page.nextCursor !== undefined)
      } catch (cause) {
        setError(cause)
      } finally {
        setLoading(false)
      }
    }, [channelId, chat, cursor, hasOlder, loading, oldestLive?.createdAt, oldestLive?.id, pageSize])

    const messages = useMemo(() => {
      const byId = new Map([...older, ...live].map((message) => [position(message).id, message]))
      return [...byId.values()].sort(
        (a, b) => position(a).createdAt - position(b).createdAt || position(a).id.localeCompare(position(b).id),
      )
    }, [live, older])

    return { messages, loadOlder, hasOlder: hasOlder && live.length > 0, loading, error }
  }

  function useChannelResources(channelId: string | null | undefined): ResourceRowOf<C>[] {
    const chat = useChat()
    return useStoreRows(channelId == null ? null : () => chat.resources(channelId), [chat, channelId])
  }

  function useResourcePresence(row: { kind: string; collection: string; docId: string }): ResourcePresenceRowOf<C>[] {
    const chat = useChat()
    const { kind, collection, docId } = row
    useEffect(() => {
      void chat.announceResource(kind, docId, 'open').catch(() => {})
      const beat = setInterval(() => void chat.announceResource(kind, docId, 'heartbeat').catch(() => {}), 20_000)
      return () => {
        clearInterval(beat)
        void chat.announceResource(kind, docId, 'close').catch(() => {})
      }
    }, [chat, kind, docId])
    const rows = useStoreRows(() => chat.resourcePresence(collection, docId), [chat, collection, docId])
    const cutoff = Date.now() - PRESENCE_LIVE_MS
    return rows.filter((p) => (p as { heartbeatAt: number }).heartbeatAt > cutoff)
  }

  return {
    ChatProvider,
    useChat,
    useChannels,
    useMembers,
    useMessages,
    useMessageParts,
    useMe,
    useChannelBusy,
    useChatHistory,
    useChannelResources,
    useResourcePresence,
  }
}
