import { eq } from '@super-line/core'
import type { CollectionName, CollectionQuery, Contract, RoleOf, RowOf } from '@super-line/core'
import type { LiveRowSet, SuperLineClient } from '@super-line/client'
import type { ChannelVisibility, ChatChannel, ChatMembership, ChatMessage, MemberRole } from './index.js'

/** Contract-aware row types with structural fallbacks (so the client half also types against a bare Contract). */
type Row<C extends Contract, N extends string, Fallback> = N extends CollectionName<C>
  ? RowOf<C, N & CollectionName<C>>
  : Fallback
export type ChannelRowOf<C extends Contract> = Row<C, 'channels', ChatChannel>
export type MembershipRowOf<C extends Contract> = Row<C, 'memberships', ChatMembership>
export type MessageRowOf<C extends Contract> = Row<C, 'messages', ChatMessage>
/** The HOST-PARAMETRIZED message body type, extracted from the contract (decision 8). */
export type ContentOf<C extends Contract> = MessageRowOf<C> extends { content: infer T } ? T : unknown

/**
 * A small reactive row store: `useSyncExternalStore`-shaped (`subscribe` takes a plain notifier, `rows()`
 * returns a stable snapshot reference). Internally it owns a live server subscription and REPLACES it
 * whenever your channel set changes — see {@link ChatClient}.
 */
export interface ChatLiveStore<RowT> {
  /** The current rows (stable reference between change notifications). */
  rows(): RowT[]
  /** Subscribe to changes; returns an unsubscribe. */
  subscribe(cb: () => void): () => void
  /** Resolves once the FIRST snapshot has been applied. */
  readonly ready: Promise<void>
  /** Stop the store and its server subscription. */
  close(): void
}

export interface ChatClientOptions {
  /**
   * The signed-in user's id (from `authClient`'s state or `whoami`). Omit to let the chat client resolve
   * it with a `whoami` round-trip; pass `null` for a known guest (stores stay empty, requests throw).
   */
  userId?: string | null
  /** The live message window per channel store (initial snapshot AND maintained window). Default 200. */
  messageLimit?: number
}

export interface ChatClient<C extends Contract> {
  /** Live directory of every channel you can see (public + your private ones). */
  channels(): ChatLiveStore<ChannelRowOf<C>>
  /** Live member list of one channel. */
  members(channelId: string): ChatLiveStore<MembershipRowOf<C>>
  /** Live message window of one channel, chronological (oldest→newest), newest-N limited. */
  messages(channelId: string, opts?: { limit?: number }): ChatLiveStore<MessageRowOf<C>>

  createChannel(input: {
    name: string
    visibility?: ChannelVisibility
    metadata?: Record<string, unknown>
  }): Promise<ChannelRowOf<C>>
  updateChannel(id: string, patch: { name?: string; metadata?: Record<string, unknown> }): Promise<ChannelRowOf<C>>
  deleteChannel(id: string): Promise<void>
  join(channelId: string): Promise<MembershipRowOf<C>>
  leave(channelId: string): Promise<void>
  addMember(channelId: string, userId: string, role?: MemberRole): Promise<MembershipRowOf<C>>
  removeMember(channelId: string, userId: string): Promise<void>
  setMemberRole(channelId: string, userId: string, role: MemberRole): Promise<MembershipRowOf<C>>
  send(channelId: string, content: ContentOf<C>, metadata?: Record<string, unknown>): Promise<MessageRowOf<C>>
  editMessage(id: string, patch: { content?: ContentOf<C>; metadata?: Record<string, unknown> }): Promise<MessageRowOf<C>>
  deleteMessage(id: string): Promise<void>

  /** Resolves once the membership watcher is armed (userId resolved + own-membership snapshot applied). */
  readonly ready: Promise<void>
  /** Close every store and the membership watcher (NOT the underlying super-line client). */
  close(): void
}

/** The chat surface as it appears on any live client (the fragment puts it on `shared`). */
interface Dyn {
  whoami(): Promise<{ userId: string } | null>
  createChannel(i: unknown): Promise<unknown>
  updateChannel(i: unknown): Promise<unknown>
  deleteChannel(i: unknown): Promise<unknown>
  joinChannel(i: unknown): Promise<unknown>
  leaveChannel(i: unknown): Promise<unknown>
  addMember(i: unknown): Promise<unknown>
  removeMember(i: unknown): Promise<unknown>
  setMemberRole(i: unknown): Promise<unknown>
  sendMessage(i: unknown): Promise<unknown>
  editMessage(i: unknown): Promise<unknown>
  deleteMessage(i: unknown): Promise<unknown>
  collection(n: string): { subscribe(q?: CollectionQuery): LiveRowSet<unknown> }
}

/**
 * The chat client half: typed request methods + live row stores that OWN the re-subscribe mechanic.
 * Server read filters are captured at subscribe time, so when your membership changes the server must be
 * asked again — this client keeps ONE stable subscription on your own membership rows and, whenever your
 * channel set changes, tears down and re-opens every open store's subscription. Hosts (and agents — this
 * has no React or TanStack dependency) never learn that dance exists.
 *
 * One instance wraps ONE connected client; after a login/logout reconnect, build a fresh `chatClient`.
 */
export function chatClient<C extends Contract, R extends RoleOf<C>>(
  client: SuperLineClient<C, R>,
  opts?: ChatClientOptions,
): ChatClient<C> {
  const dyn = client as unknown as Dyn
  const defaultLimit = opts?.messageLimit ?? 200

  interface Handle {
    rekey(): void
    close(): void
  }
  const stores = new Set<Handle>()

  function makeStore<RowT>(open: () => LiveRowSet<unknown>, present: (rows: RowT[]) => RowT[] = (r) => r): ChatLiveStore<RowT> {
    let live = open()
    let snapshot: RowT[] = []
    let closed = false
    const listeners = new Set<() => void>()
    let resolveReady!: () => void
    const ready = new Promise<void>((res) => (resolveReady = res))
    const refresh = (): void => {
      snapshot = present(live.rows() as RowT[])
      for (const l of listeners) l()
    }
    let detach: () => void = () => {}
    const attach = (): void => {
      const mine = live
      detach = mine.subscribe(() => {
        if (live === mine && !closed) refresh()
      })
      void mine.ready
        .then(() => {
          if (live === mine && !closed) refresh()
        })
        .catch(() => {}) // a denied subscribe just leaves the store empty
        .finally(() => resolveReady())
    }
    attach()
    const handle: Handle = {
      rekey: () => {
        if (closed) return
        detach()
        live.close()
        live = open()
        attach()
      },
      close: () => {
        closed = true
        detach()
        live.close()
        stores.delete(handle)
      },
    }
    stores.add(handle)
    return {
      rows: () => snapshot,
      subscribe: (cb) => {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      },
      ready,
      close: handle.close,
    }
  }

  // ── the membership watcher: ONE stable subscription drives every store's re-subscribe ────────────
  // Its filter (own rows) matches the policy's stable eq(userId) arm, so it never goes deaf itself.
  let watcher: LiveRowSet<unknown> | undefined
  const ready = (async () => {
    const userId = opts?.userId !== undefined ? opts.userId : ((await dyn.whoami())?.userId ?? null)
    if (!userId) return // guest: nothing to watch, stores stay empty
    watcher = dyn.collection('memberships').subscribe({ filter: eq('userId', userId) })
    const w = watcher
    const channelKey = (): string =>
      (w.rows() as ChatMembership[])
        .map((m) => m.channelId)
        .sort()
        .join(',')
    let baseline: string | null = null // null until the catch-up snapshot applied — events before that are the snapshot itself
    w.subscribe(() => {
      if (baseline === null) return
      const key = channelKey()
      if (key === baseline) return
      baseline = key
      for (const s of stores) s.rekey() // membership changed → server must re-evaluate every read filter
    })
    await w.ready
    baseline = channelKey()
  })()

  return {
    channels: () => makeStore(() => dyn.collection('channels').subscribe({})),
    members: (channelId) => makeStore(() => dyn.collection('memberships').subscribe({ filter: eq('channelId', channelId) })),
    messages: (channelId, o) =>
      makeStore(
        () =>
          dyn.collection('messages').subscribe({
            filter: eq('channelId', channelId),
            orderBy: [{ field: 'createdAt', dir: 'desc' }, { field: 'id', dir: 'desc' }],
            limit: o?.limit ?? defaultLimit,
          }),
        // the wire window keeps the newest N (desc); present chronologically
        (rows) => [...rows].reverse(),
      ),

    createChannel: (input) => dyn.createChannel(input) as Promise<ChannelRowOf<C>>,
    updateChannel: (id, patch) => dyn.updateChannel({ id, ...patch }) as Promise<ChannelRowOf<C>>,
    deleteChannel: async (id) => void (await dyn.deleteChannel({ id }))
    ,
    join: (channelId) => dyn.joinChannel({ channelId }) as Promise<MembershipRowOf<C>>,
    leave: async (channelId) => void (await dyn.leaveChannel({ channelId })),
    addMember: (channelId, userId, role) =>
      dyn.addMember({ channelId, userId, ...(role ? { role } : {}) }) as Promise<MembershipRowOf<C>>,
    removeMember: async (channelId, userId) => void (await dyn.removeMember({ channelId, userId })),
    setMemberRole: (channelId, userId, role) =>
      dyn.setMemberRole({ channelId, userId, role }) as Promise<MembershipRowOf<C>>,
    send: (channelId, content, metadata) =>
      dyn.sendMessage({ channelId, content, ...(metadata ? { metadata } : {}) }) as Promise<MessageRowOf<C>>,
    editMessage: (id, patch) => dyn.editMessage({ id, ...patch }) as Promise<MessageRowOf<C>>,
    deleteMessage: async (id) => void (await dyn.deleteMessage({ id })),

    ready,
    close: () => {
      for (const s of stores) s.close()
      watcher?.close()
    },
  }
}
