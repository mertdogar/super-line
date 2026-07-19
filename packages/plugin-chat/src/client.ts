import { and, eq, lt, or } from '@super-line/core'
import { docKeyOf } from './index.js'
import type { CollectionName, CollectionQuery, Contract, RoleOf, RowOf } from '@super-line/core'
import type { LiveRowSet, SuperLineClient } from '@super-line/client'
import type {
  ChannelVisibility,
  ChatChannel,
  ChatMembership,
  ChatMessage,
  ChatMessagePart,
  ChatResource,
  ChatStreamEvent,
  MemberRole,
  MessageStatus,
  ResourcePresence,
  ResourceWriteOp,
} from './index.js'

/** Contract-aware row types with structural fallbacks (so the client half also types against a bare Contract). */
type Row<C extends Contract, N extends string, Fallback> = N extends CollectionName<C>
  ? RowOf<C, N & CollectionName<C>>
  : Fallback
export type ChannelRowOf<C extends Contract> = Row<C, 'channels', ChatChannel>
export type MembershipRowOf<C extends Contract> = Row<C, 'memberships', ChatMembership>
export type MessageRowOf<C extends Contract> = Row<C, 'messages', ChatMessage>
export type MessagePartRowOf<C extends Contract> = Row<C, 'messageParts', ChatMessagePart>
export type ResourceRowOf<C extends Contract> = Row<C, 'resources', ChatResource>
export type ResourcePresenceRowOf<C extends Contract> = Row<C, 'resourcePresence', ResourcePresence>
/** The HOST-PARAMETRIZED message body type, extracted from the contract (decision 8). */
export type ContentOf<C extends Contract> = MessageRowOf<C> extends { content?: infer T } ? NonNullable<T> : unknown
export type PartDataOf<C extends Contract> = Extract<MessagePartRowOf<C>, { type: 'data' }> extends {
  data: infer Data
}
  ? Data
  : never
export type StreamEventOf<C extends Contract> = ChatStreamEvent<PartDataOf<C>>

export interface HistoryCursor {
  createdAt: number
  id: string
}

export interface HistoryPage<Message> {
  messages: Message[]
  nextCursor?: HistoryCursor
}

export interface PartTreeNode<Part> {
  part: Part
  children: PartTreeNode<Part>[]
}

/** Attach a part's lane beneath the tool part named by `parent`; root parts stay top-level. */
export function buildPartTree<Part extends { type: string; parent: string | null; toolCallId?: string; idx: number }>(
  parts: readonly Part[],
): PartTreeNode<Part>[] {
  const nodes = [...parts].sort((a, b) => a.idx - b.idx).map((part) => ({ part, children: [] as PartTreeNode<Part>[] }))
  const tools = new Map(nodes.flatMap((node) => (node.part.type === 'tool' && node.part.toolCallId ? [[node.part.toolCallId, node] as const] : [])))
  const roots: PartTreeNode<Part>[] = []
  for (const node of nodes) {
    const parent = node.part.parent === null ? undefined : tools.get(node.part.parent)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function partsText(parts: readonly { type: string; parent: string | null; text?: string }[], parent: string | null = null): string {
  return parts
    .filter((part) => part.type === 'text' && part.parent === parent)
    .map((part) => part.text ?? '')
    .join('')
}

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

/**
 * A producer handle on one open streamed message. `push` queues events synchronously; the writer
 * micro-batches them onto `appendMessage` (~80ms flush) in strict order. A wire failure (cap
 * violation, hook veto, disconnect) is surfaced at the NEXT `flush`/`finalize` — settle in a
 * `finally` (`abort` tolerates a server that already settled it).
 */
export interface ChatStreamHandle<C extends Contract> {
  readonly messageId: string
  /** Aborts when another authorized channel member cancels this message. */
  readonly signal: AbortSignal
  /** Queue events (order preserved). No-op once the stream failed or a settle has STARTED. */
  push(...events: StreamEventOf<C>[]): void
  /** Send everything queued now (sliced into safe batch sizes); rejects with the first wire failure. */
  flush(): Promise<void>
  /** Flush, then settle (default `complete`). Memoized: a second call returns the same settle. */
  finalize(opts?: { status?: Exclude<MessageStatus, 'streaming'>; error?: string }): Promise<MessageRowOf<C>>
  /** Producer-side abort: drops the queue and settles `aborted`. No-op after any prior settle, local or server-side. */
  abort(error?: string): Promise<void>
}

export interface ChatClient<C extends Contract> {
  /** Live directory of every channel you can see (public + your private ones). */
  channels(): ChatLiveStore<ChannelRowOf<C>>
  /** Live member list of one channel. */
  members(channelId: string): ChatLiveStore<MembershipRowOf<C>>
  /** Live chronological newest-N message envelopes. Detailed parts are a separate, complete store. */
  messages(channelId: string, opts?: { limit?: number }): ChatLiveStore<MessageRowOf<C>>
  /** One older page, chronological, keyset-paginated by `{createdAt,id}`. The page is a snapshot. */
  history(
    channelId: string,
    opts?: { before?: HistoryCursor; limit?: number },
  ): Promise<HistoryPage<MessageRowOf<C>>>
  /** Every durable part of one message, tree-ordered and live until closed. */
  messageParts(channelId: string, messageId: string): ChatLiveStore<MessagePartRowOf<C>>
  /** Open a streamed message in a channel you are a member of and get its producer handle. */
  stream(channelId: string, opts?: { metadata?: Record<string, unknown> }): Promise<ChatStreamHandle<C>>
  /**
   * Live registry of one channel's resources (PLAN-chat-resources). Open a row's doc with the
   * NATIVE surface: `client.collection(row.collection).open(row.docId)` / `useDoc` — chat wraps
   * nothing there.
   */
  resources(channelId: string): ChatLiveStore<ResourceRowOf<C>>
  /** Live who's-open rows for one resource doc. Liveness is `heartbeatAt` recency — filter with {@link PRESENCE_LIVE_MS}. */
  resourcePresence(collection: string, docId: string): ChatLiveStore<ResourcePresenceRowOf<C>>

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
  /** Ask the producer to stop an active streamed message. */
  cancelMessage(id: string, reason?: string): Promise<void>
  /** Create-or-attach a resource: `id` (linked kinds) attaches/creates under a host doc id; `params` feed the kind's `init`. */
  createResource(
    channelId: string,
    opts: { kind: string; title?: string; id?: string; params?: Record<string, unknown> },
  ): Promise<ResourceRowOf<C>>
  /** Detach a resource (owned kinds: the doc is deleted with it). */
  detachResource(channelId: string, kind: string, docId: string): Promise<ResourceRowOf<C>>
  /**
   * The ACKED write path: path ops applied server-side with a synchronous answer — a schema-invalid
   * result rejects with `VALIDATION` (the raw `DocHandle` is void+optimistic and can't tell you).
   * Live UIs keep using the DocHandle; use this when you need to KNOW the write landed (agents do).
   */
  writeResource(channelId: string, kind: string, docId: string, ops: ResourceWriteOp[]): Promise<{ snapshot: unknown }>
  /** Announce who's-open presence on a resource (open on mount, heartbeat ~20s, close on unmount — `useResourcePresence` does this for you). */
  announceResource(kind: string, docId: string, state: 'open' | 'heartbeat' | 'close'): Promise<void>

  /** Resolves once the membership watcher is armed (userId resolved + own-membership snapshot applied). */
  readonly ready: Promise<void>
  /** The resolved own user id (`null` for a guest). Populated by `ready` — read it after awaiting. */
  readonly userId: string | null
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
  startMessage(i: unknown): Promise<unknown>
  appendMessage(i: unknown): Promise<unknown>
  finalizeMessage(i: unknown): Promise<unknown>
  cancelMessage(i: unknown): Promise<unknown>
  watchChannel(i: unknown): Promise<unknown>
  unwatchChannel(i: unknown): Promise<unknown>
  createResource(i: unknown): Promise<unknown>
  detachResource(i: unknown): Promise<unknown>
  writeResource(i: unknown): Promise<unknown>
  announceResource(i: unknown): Promise<unknown>
  collection(n: string): { subscribe(q?: CollectionQuery): LiveRowSet<unknown> }
  on(event: string, handler: (data: never) => void): () => void
  onReconnect?(cb: () => void): () => void
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

  const watchedChannels = new Map<string, number>()
  const watchChannel = (channelId: string): void => void dyn.watchChannel({ channelId }).catch(() => {})
  const acquireWatch = (channelId: string): (() => void) => {
    const count = watchedChannels.get(channelId) ?? 0
    watchedChannels.set(channelId, count + 1)
    if (count === 0) watchChannel(channelId)
    return () => {
      const next = (watchedChannels.get(channelId) ?? 1) - 1
      if (next > 0) watchedChannels.set(channelId, next)
      else {
        watchedChannels.delete(channelId)
        void dyn.unwatchChannel({ channelId }).catch(() => {})
      }
    }
  }
  const offReconnect = dyn.onReconnect?.(() => {
    for (const channelId of watchedChannels.keys()) watchChannel(channelId)
  }) ?? (() => {})

  const msgQuery = (channelId: string, limit: number, before?: HistoryCursor): CollectionQuery => ({
    filter: before
      ? and(
          eq('channelId', channelId),
          or(lt('createdAt', before.createdAt), and(eq('createdAt', before.createdAt), lt('id', before.id))),
        )
      : eq('channelId', channelId),
    orderBy: [
      { field: 'createdAt', dir: 'desc' },
      { field: 'id', dir: 'desc' },
    ],
    limit,
  })

  /** Parts in tree order: roots by idx; each tool part immediately followed by its subtree. */
  function treeOrder<Part extends ChatMessagePart>(list: Part[]): Part[] {
    const sorted = [...list].sort((a, b) => a.idx - b.idx)
    const children = new Map<string, Part[]>()
    const roots: Part[] = []
    for (const p of sorted) {
      if (p.parent) {
        const l = children.get(p.parent) ?? []
        l.push(p)
        children.set(p.parent, l)
      } else roots.push(p)
    }
    const out: Part[] = []
    const visit = (p: Part): void => {
      out.push(p)
      if (p.type === 'tool' && p.toolCallId) for (const c of children.get(p.toolCallId) ?? []) visit(c)
    }
    for (const r of roots) visit(r)
    // a child whose anchor row hasn't landed yet is appended, not dropped
    if (out.length < sorted.length) for (const p of sorted) if (!out.includes(p)) out.push(p)
    return out
  }

  function makeMessagePartsStore(channelId: string, messageId: string): ChatLiveStore<MessagePartRowOf<C>> {
    const partsQuery = (): CollectionQuery => ({
      filter: and(eq('channelId', channelId), eq('messageId', messageId)),
      orderBy: [{ field: 'idx', dir: 'asc' }],
    })

    let parts = dyn.collection('messageParts').subscribe(partsQuery())
    let closed = false
    let snapshot: MessagePartRowOf<C>[] = []
    const listeners = new Set<() => void>()

    // Live overlay per part pk: the full text as known live (checkpoint + spliced deltas).
    const overlays = new Map<string, { len: number; text: string }>()
    // Deltas that don't line up yet (part row not seen / checkpoint behind); drained on row changes.
    const pending = new Map<string, { offset: number; text: string }[]>()

    const partIndex = (): Map<string, ChatMessagePart> => {
      const idx = new Map<string, ChatMessagePart>()
      for (const p of parts.rows() as ChatMessagePart[]) idx.set(p.id, p)
      return idx
    }

    /** Reconcile one part's overlay with its row, then drain its buffered deltas in offset order. */
    const reconcile = (pk: string, row: ChatMessagePart | undefined): void => {
      let ov = overlays.get(pk)
      if (row?.done) {
        overlays.delete(pk)
        pending.delete(pk)
        return
      }
      if (row && row.type !== 'text' && row.type !== 'reasoning') {
        overlays.delete(pk)
        pending.delete(pk)
        return
      }
      if (row && ov && row.offset >= ov.len) {
        overlays.delete(pk)
        ov = undefined
      }
      const buf = pending.get(pk)
      if (!buf || !row) return
      buf.sort((a, b) => a.offset - b.offset)
      if (row.type !== 'text' && row.type !== 'reasoning') return
      let known = ov ? ov.len : row.offset
      let text = ov ? ov.text : row.text
      while (buf.length > 0) {
        const d = buf[0]!
        if (d.offset + d.text.length <= known) {
          buf.shift() // fully stale (already checkpointed)
          continue
        }
        if (d.offset > known) break // gap — the next checkpoint heals it
        const fresh = d.text.slice(known - d.offset)
        text += fresh
        known += fresh.length
        buf.shift()
      }
      if (buf.length === 0) pending.delete(pk)
      if (known > row.offset) overlays.set(pk, { len: known, text })
    }

    const present = (p: ChatMessagePart): ChatMessagePart => {
      if (p.type !== 'text' && p.type !== 'reasoning') return p
      const ov = overlays.get(p.id)
      return ov && !p.done && ov.len > p.offset ? { ...p, text: ov.text, offset: ov.len } : p
    }

    const rebuild = (): void => {
      if (closed) return
      snapshot = treeOrder((parts.rows() as ChatMessagePart[]).map(present)) as MessagePartRowOf<C>[]
      for (const l of listeners) l()
    }

    const onDelta = (d: { channelId: string; messageId: string; partIdx: number; offset: number; text: string }): void => {
      if (closed || d.channelId !== channelId || d.messageId !== messageId) return
      const pk = `${d.messageId}:${d.partIdx}`
      let buf = pending.get(pk)
      if (!buf) pending.set(pk, (buf = []))
      if (buf.length < 512) buf.push({ offset: d.offset, text: d.text }) // rogue-broadcast bound
      reconcile(pk, partIndex().get(pk))
      rebuild()
    }

    let detachParts: () => void = () => {}
    let resolveReady!: () => void
    const ready = new Promise<void>((res) => (resolveReady = res))
    const attach = (): void => {
      const p = parts
      detachParts = p.subscribe(() => {
        if (parts !== p || closed) return
        // a row change may unlock buffered deltas (part arrived / checkpoint advanced) or obsolete an overlay
        const idx = partIndex()
        for (const pk of pending.keys()) reconcile(pk, idx.get(pk)) // Maps tolerate delete-during-iteration
        for (const pk of overlays.keys()) reconcile(pk, idx.get(pk))
        rebuild()
      })
      void p.ready.catch(() => {}).then(() => {
        if (parts === p && !closed) rebuild()
        resolveReady()
      })
    }
    attach()
    const offDelta = dyn.on('chat.streamDelta', onDelta as never)
    const releaseWatch = acquireWatch(channelId)

    const handle: Handle = {
      rekey: () => {
        if (closed) return
        detachParts()
        parts.close()
        parts = dyn.collection('messageParts').subscribe(partsQuery())
        attach()
      },
      close: () => {
        closed = true
        detachParts()
        parts.close()
        offDelta()
        releaseWatch()
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

  async function history(
    channelId: string,
    opts?: { before?: HistoryCursor; limit?: number },
  ): Promise<HistoryPage<MessageRowOf<C>>> {
    const limit = Math.max(1, opts?.limit ?? 50)
    const live = dyn.collection('messages').subscribe(msgQuery(channelId, limit + 1, opts?.before))
    try {
      await live.ready
      const rows = live.rows() as MessageRowOf<C>[]
      const page = rows.slice(0, limit)
      const oldest = page.at(-1) as (MessageRowOf<C> & { createdAt: number; id: string }) | undefined
      return {
        messages: [...page].reverse(),
        ...(rows.length > limit && oldest ? { nextCursor: { createdAt: oldest.createdAt, id: oldest.id } } : {}),
      }
    } finally {
      live.close()
    }
  }

  // ── the producer writer: micro-batched appends in strict order ────────────────────────────────────

  const FLUSH_MS = 80
  const FLUSH_MAX = 100 // stay well under the server's default maxEventsPerAppend
  const openStreams = new Map<string, { cancel(reason: string): void }>()
  const offCancel = dyn.on(
    'chat.streamCancelled',
    ((event: { messageId: string; reason: string }) => openStreams.get(event.messageId)?.cancel(event.reason)) as never,
  )

  async function openStream(
    channelId: string,
    sopts?: { metadata?: Record<string, unknown> },
  ): Promise<ChatStreamHandle<C>> {
    const started = (await dyn.startMessage({
      channelId,
      ...(sopts?.metadata !== undefined ? { metadata: sopts.metadata } : {}),
    })) as MessageRowOf<C> & { id: string }
    const controller = new AbortController()
    let queue: StreamEventOf<C>[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let chain: Promise<void> = Promise.resolve()
    let failed: unknown
    let closing = false // intake shut the moment a settle STARTS — a push during finalize's flush is a true no-op
    let settling: Promise<MessageRowOf<C>> | undefined // the one settle, memoized (double-finalize returns it)

    const doFlush = (): Promise<void> => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // slice into ≤FLUSH_MAX batches — one huge push must not become one oversized appendMessage
      // that trips the server's per-call cap (which would abort the whole stream)
      while (queue.length > 0 && failed === undefined) {
        const batch = queue.splice(0, FLUSH_MAX)
        chain = chain
          .then(() => dyn.appendMessage({ id: started.id, events: batch }))
          .then(
            () => undefined,
            (e: unknown) => {
              if (failed === undefined) failed = e
            },
          )
      }
      return chain.then(() => {
        if (failed !== undefined && !closing) throw failed // post-settle flushes stay quiet; finalize re-checks itself
      })
    }
    const schedule = (): void => {
      if (queue.length >= FLUSH_MAX) {
        void doFlush().catch(() => {}) // surfaced at the next explicit flush/finalize
        return
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (!closing) void doFlush().catch(() => {})
        }, FLUSH_MS)
        ;(timer as { unref?: () => void }).unref?.()
      }
    }

    const cleanup = (): void => void openStreams.delete(started.id)
    const handle: ChatStreamHandle<C> = {
      messageId: started.id,
      signal: controller.signal,
      push: (...events) => {
        if (failed !== undefined || closing || events.length === 0) return
        queue.push(...events)
        schedule()
      },
      flush: doFlush,
      finalize: (fo = {}) =>
        (settling ??= (async () => {
          closing = true // no event pushed from here on is accepted — the contract's no-op, honestly kept
          await doFlush().catch(() => {}) // drain; a failure is re-thrown explicitly below
          if (failed !== undefined) throw failed
          return (await dyn.finalizeMessage({
            id: started.id,
            ...(fo.status !== undefined ? { status: fo.status } : {}),
            ...(fo.error !== undefined ? { error: fo.error } : {}),
          })) as MessageRowOf<C>
        })().finally(cleanup)),
      abort: async (error) => {
        if (!controller.signal.aborted) controller.abort(error)
        if (settling !== undefined) {
          await settling.catch(() => {}) // a settle already ran (or is running) — abort is a no-op
          return
        }
        closing = true
        queue = []
        if (timer !== undefined) clearTimeout(timer)
        await chain.catch(() => {})
        settling = (dyn.finalizeMessage({
          id: started.id,
          status: 'aborted',
          ...(error !== undefined ? { error } : {}),
        }) as Promise<MessageRowOf<C>>).finally(cleanup)
        try {
          await settling
        } catch (e) {
          // CONFLICT = the server already settled it (cap violation, disconnect, kill-switch) — abort is then a no-op
          if ((e as { code?: string }).code !== 'CONFLICT') throw e
        }
      },
    }
    openStreams.set(started.id, {
      cancel: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason)
        void handle.abort(reason).catch(() => {})
      },
    })
    return handle
  }

  // ── the membership watcher: ONE stable subscription drives every store's re-subscribe ────────────
  // Its filter (own rows) matches the policy's stable eq(userId) arm, so it never goes deaf itself.
  let watcher: LiveRowSet<unknown> | undefined
  let selfId: string | null = null
  const ready = (async () => {
    const userId = opts?.userId !== undefined ? opts.userId : ((await dyn.whoami())?.userId ?? null)
    selfId = userId
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
        () => dyn.collection('messages').subscribe(msgQuery(channelId, o?.limit ?? defaultLimit)),
        (rows: MessageRowOf<C>[]) => [...rows].reverse(),
      ),
    history,
    messageParts: makeMessagePartsStore,
    stream: (channelId, sopts) => openStream(channelId, sopts),
    resources: (channelId) => makeStore(() => dyn.collection('resources').subscribe({ filter: eq('channelId', channelId) })),
    resourcePresence: (collection, docId) =>
      makeStore(() => dyn.collection('resourcePresence').subscribe({ filter: eq('docKey', docKeyOf(collection, docId)) })),

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
    cancelMessage: async (id, reason) =>
      void (await dyn.cancelMessage({ id, ...(reason !== undefined ? { reason } : {}) })),
    createResource: (channelId, o) => dyn.createResource({ channelId, ...o }) as Promise<ResourceRowOf<C>>,
    detachResource: (channelId, kind, docId) =>
      dyn.detachResource({ channelId, kind, docId }) as Promise<ResourceRowOf<C>>,
    writeResource: (channelId, kind, docId, ops) =>
      dyn.writeResource({ channelId, kind, docId, ops }) as Promise<{ snapshot: unknown }>,
    announceResource: async (kind, docId, state) => void (await dyn.announceResource({ kind, docId, state })),

    ready,
    get userId() {
      return selfId
    },
    close: () => {
      for (const stream of openStreams.values()) stream.cancel('chat client closed')
      offCancel()
      offReconnect()
      for (const s of stores) s.close()
      watcher?.close()
    },
  }
}
