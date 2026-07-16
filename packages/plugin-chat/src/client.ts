import { eq } from '@super-line/core'
import type { CollectionName, CollectionQuery, Contract, RoleOf, RowOf } from '@super-line/core'
import type { LiveRowSet, SuperLineClient } from '@super-line/client'
import type {
  ChannelVisibility,
  ChatChannel,
  ChatMembership,
  ChatMessage,
  ChatMessagePart,
  ChatStreamEvent,
  MemberRole,
  MessageStatus,
} from './index.js'

/** Contract-aware row types with structural fallbacks (so the client half also types against a bare Contract). */
type Row<C extends Contract, N extends string, Fallback> = N extends CollectionName<C>
  ? RowOf<C, N & CollectionName<C>>
  : Fallback
export type ChannelRowOf<C extends Contract> = Row<C, 'channels', ChatChannel>
export type MembershipRowOf<C extends Contract> = Row<C, 'memberships', ChatMembership>
export type MessageRowOf<C extends Contract> = Row<C, 'messages', ChatMessage>
export type MessagePartRowOf<C extends Contract> = Row<C, 'messageParts', ChatMessagePart>
/** The HOST-PARAMETRIZED message body type, extracted from the contract (decision 8). */
export type ContentOf<C extends Contract> = MessageRowOf<C> extends { content?: infer T } ? NonNullable<T> : unknown

/**
 * What the assembled feed serves (decision 9): a plain message passes through untouched (`parts`
 * absent); a STREAMED message carries its parts in tree order (parent chains — a delegate tool part
 * is followed by its subagent's parts), with in-flight text already overlaid from live deltas.
 */
export type AssembledMessageOf<C extends Contract> = MessageRowOf<C> & { parts?: MessagePartRowOf<C>[] }

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
  /**
   * The parts window per channel store, most-recently-active first. Default 1000. Bounds the client's
   * memory to recent activity instead of total channel history: a settled streamed message whose parts
   * fell out of this window arrives with `parts` ABSENT — render its `content` projection instead.
   */
  partsLimit?: number
}

/**
 * A producer handle on one open streamed message. `push` queues events synchronously; the writer
 * micro-batches them onto `appendMessage` (~80ms flush) in strict order. A wire failure (cap
 * violation, hook veto, disconnect) is surfaced at the NEXT `flush`/`finalize` — settle in a
 * `finally` (`abort` tolerates a server that already settled it).
 */
export interface ChatStreamHandle<C extends Contract> {
  readonly messageId: string
  /** Queue events (order preserved). No-op once the stream failed or a settle has STARTED. */
  push(...events: ChatStreamEvent[]): void
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
  /**
   * Live message window of one channel, chronological (oldest→newest), newest-N limited. Streamed
   * messages arrive ASSEMBLED (see {@link AssembledMessageOf}): the store also subscribes the
   * channel's parts, watches the delta room, and splices live text by offset — one feed, no
   * second API. `streaming: false` opts out (plain rows only, no parts subscription, no watch).
   */
  messages(
    channelId: string,
    opts?: { limit?: number; partsLimit?: number; streaming?: boolean },
  ): ChatLiveStore<AssembledMessageOf<C>>
  /** Open a streamed message in a channel you are a member of and get its producer handle. */
  stream(channelId: string, opts?: { metadata?: Record<string, unknown> }): Promise<ChatStreamHandle<C>>

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
  startMessage(i: unknown): Promise<unknown>
  appendMessage(i: unknown): Promise<unknown>
  finalizeMessage(i: unknown): Promise<unknown>
  watchChannel(i: unknown): Promise<unknown>
  unwatchChannel(i: unknown): Promise<unknown>
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
  const defaultPartsLimit = opts?.partsLimit ?? 1000

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

  // ── the assembled messages store (PLAN-chat-streaming decision 9) ────────────────────────────────
  // One feed: the store composes the message window + the channel's parts rows + the ephemeral
  // delta room, and serves plain rows untouched. Deltas splice by OFFSET on top of the last
  // checkpointed row text; anything that doesn't line up waits (≤ checkpointMs) for the next
  // checkpoint — a lost delta degrades smoothness, never correctness.

  const msgQuery = (channelId: string, limit: number): CollectionQuery => ({
    filter: eq('channelId', channelId),
    orderBy: [
      { field: 'createdAt', dir: 'desc' },
      { field: 'id', dir: 'desc' },
    ],
    limit,
  })

  /** Parts in tree order: roots by idx; each tool part immediately followed by its subtree. */
  function treeOrder(list: ChatMessagePart[]): ChatMessagePart[] {
    const sorted = [...list].sort((a, b) => a.idx - b.idx)
    const children = new Map<string, ChatMessagePart[]>()
    const roots: ChatMessagePart[] = []
    for (const p of sorted) {
      if (p.parent) {
        const l = children.get(p.parent) ?? []
        l.push(p)
        children.set(p.parent, l)
      } else roots.push(p)
    }
    const out: ChatMessagePart[] = []
    const visit = (p: ChatMessagePart): void => {
      out.push(p)
      if (p.type === 'tool' && p.toolCallId) for (const c of children.get(p.toolCallId) ?? []) visit(c)
    }
    for (const r of roots) visit(r)
    // a child whose anchor row hasn't landed yet is appended, not dropped
    if (out.length < sorted.length) for (const p of sorted) if (!out.includes(p)) out.push(p)
    return out
  }

  function makeMessagesStore(
    channelId: string,
    o?: { limit?: number; partsLimit?: number; streaming?: boolean },
  ): ChatLiveStore<AssembledMessageOf<C>> {
    if (o?.streaming === false)
      return makeStore(
        () => dyn.collection('messages').subscribe(msgQuery(channelId, o?.limit ?? defaultLimit)),
        (rows: AssembledMessageOf<C>[]) => [...rows].reverse(),
      )

    // The parts window is RECENCY-bounded (lastActivityAt desc), not tied to total channel history —
    // otherwise opening an old channel would pull every part ever streamed into memory. A settled
    // message whose parts fell out of the window assembles WITHOUT `parts`; its content projection
    // carries the rendering.
    const partsQuery = (): CollectionQuery => ({
      filter: eq('channelId', channelId),
      orderBy: [
        { field: 'lastActivityAt', dir: 'desc' },
        { field: 'id', dir: 'desc' },
      ],
      limit: o?.partsLimit ?? defaultPartsLimit,
    })

    let msgs = dyn.collection('messages').subscribe(msgQuery(channelId, o?.limit ?? defaultLimit))
    let parts = dyn.collection('messageParts').subscribe(partsQuery())
    let closed = false
    let snapshot: AssembledMessageOf<C>[] = []
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
      if (row && (row.done || (ov && row.offset >= ov.len))) {
        overlays.delete(pk)
        ov = undefined
      }
      if (row?.done) {
        pending.delete(pk)
        return
      }
      const buf = pending.get(pk)
      if (!buf || !row) return
      buf.sort((a, b) => a.offset - b.offset)
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
      const ov = overlays.get(p.id)
      return ov && !p.done && ov.len > p.offset ? { ...p, text: ov.text, offset: ov.len } : p
    }

    const assemble = (): AssembledMessageOf<C>[] => {
      const byMsg = new Map<string, ChatMessagePart[]>()
      for (const p of parts.rows() as ChatMessagePart[]) {
        const list = byMsg.get(p.messageId) ?? []
        list.push(p)
        byMsg.set(p.messageId, list)
      }
      const window = [...(msgs.rows() as (MessageRowOf<C> & { id: string; status?: string })[])].reverse()
      return window.map((m) => {
        const raw = byMsg.get(m.id)
        // parts attach only when the window HAS them: a streamed message whose parts scrolled out of
        // the recency window (or has none yet) keeps `parts` absent — its content/status still render
        if (!raw || raw.length === 0) return m as AssembledMessageOf<C>
        return { ...m, parts: treeOrder(raw).map(present) } as unknown as AssembledMessageOf<C>
      })
    }

    const rebuild = (): void => {
      if (closed) return
      snapshot = assemble()
      for (const l of listeners) l()
    }

    const onDelta = (d: { channelId: string; messageId: string; partIdx: number; offset: number; text: string }): void => {
      if (closed || d.channelId !== channelId) return
      const pk = `${d.messageId}:${d.partIdx}`
      let buf = pending.get(pk)
      if (!buf) pending.set(pk, (buf = []))
      if (buf.length < 512) buf.push({ offset: d.offset, text: d.text }) // rogue-broadcast bound
      reconcile(pk, partIndex().get(pk))
      rebuild()
    }

    let detachMsgs: () => void = () => {}
    let detachParts: () => void = () => {}
    let resolveReady!: () => void
    const ready = new Promise<void>((res) => (resolveReady = res))
    const attach = (): void => {
      const m = msgs
      const p = parts
      detachMsgs = m.subscribe(() => {
        if (msgs === m && !closed) rebuild()
      })
      detachParts = p.subscribe(() => {
        if (parts !== p || closed) return
        // a row change may unlock buffered deltas (part arrived / checkpoint advanced) or obsolete an overlay
        const idx = partIndex()
        for (const pk of pending.keys()) reconcile(pk, idx.get(pk)) // Maps tolerate delete-during-iteration
        for (const pk of overlays.keys()) reconcile(pk, idx.get(pk))
        rebuild()
      })
      void Promise.all([m.ready.catch(() => {}), p.ready.catch(() => {})]).then(() => {
        if (msgs === m && !closed) rebuild()
        resolveReady()
      })
    }
    attach()
    const offDelta = dyn.on('chat.streamDelta', onDelta as never)
    // the delta room is conn-scoped: (re-)enter on open, on membership rekey, and after a reconnect
    const watch = (): void => void dyn.watchChannel({ channelId }).catch(() => {})
    watch()
    const offReconnect = dyn.onReconnect?.(watch) ?? (() => {})

    const handle: Handle = {
      rekey: () => {
        if (closed) return
        detachMsgs()
        detachParts()
        msgs.close()
        parts.close()
        msgs = dyn.collection('messages').subscribe(msgQuery(channelId, o?.limit ?? defaultLimit))
        parts = dyn.collection('messageParts').subscribe(partsQuery())
        attach()
        watch()
      },
      close: () => {
        closed = true
        detachMsgs()
        detachParts()
        msgs.close()
        parts.close()
        offDelta()
        offReconnect()
        void dyn.unwatchChannel({ channelId }).catch(() => {})
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

  // ── the producer writer: micro-batched appends in strict order ────────────────────────────────────

  const FLUSH_MS = 80
  const FLUSH_MAX = 100 // stay well under the server's default maxEventsPerAppend

  async function openStream(
    channelId: string,
    sopts?: { metadata?: Record<string, unknown> },
  ): Promise<ChatStreamHandle<C>> {
    const started = (await dyn.startMessage({
      channelId,
      ...(sopts?.metadata !== undefined ? { metadata: sopts.metadata } : {}),
    })) as MessageRowOf<C> & { id: string }
    let queue: ChatStreamEvent[] = []
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

    return {
      messageId: started.id,
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
        })()),
      abort: async (error) => {
        if (settling !== undefined) {
          await settling.catch(() => {}) // a settle already ran (or is running) — abort is a no-op
          return
        }
        closing = true
        queue = []
        if (timer !== undefined) clearTimeout(timer)
        await chain.catch(() => {})
        settling = dyn.finalizeMessage({
          id: started.id,
          status: 'aborted',
          ...(error !== undefined ? { error } : {}),
        }) as Promise<MessageRowOf<C>>
        try {
          await settling
        } catch (e) {
          // CONFLICT = the server already settled it (cap violation, disconnect, kill-switch) — abort is then a no-op
          if ((e as { code?: string }).code !== 'CONFLICT') throw e
        }
      },
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
    messages: (channelId, o) => makeMessagesStore(channelId, o),
    stream: (channelId, sopts) => openStream(channelId, sopts),

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
