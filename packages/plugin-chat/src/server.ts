import { randomUUID } from 'node:crypto'
import { eq, isIn, or, SuperLineError } from '@super-line/core'
import type { Contract, Expr, OrderBy } from '@super-line/core'
import type { PluginContext, SuperLinePlugin } from '@super-line/server'
import type { AuthContext, AuthUser } from '@super-line/plugin-auth'
import { memId, partId } from './index.js'
import type {
  ChatChannel,
  ChatMembership,
  ChatMessage,
  ChatMessagePart,
  ChatStreamEvent,
  ChatSurface,
  ChannelVisibility,
  MemberRole,
  MessageStatus,
  PartType,
  ToolState,
} from './index.js'

/**
 * Who triggered a domain operation. Hooks receive this so host logic can distinguish a client request
 * (spam-check it) from the host's own `chatKit` call (trust it) — but by default both run the SAME core.
 */
export type ChatInitiator = { kind: 'client'; userId: string } | { kind: 'server' }

/**
 * A before/after pair around ONE domain operation. `before` may transform (return a new input) or veto
 * (throw — nothing is written); returning nothing keeps the input. `after` observes the committed result;
 * if it throws, the error propagates to the caller but the write STAYS (it already committed).
 */
export interface ChatOpHook<In, Out> {
  before?: (input: In, initiator: ChatInitiator) => In | undefined | void | Promise<In | undefined | void>
  after?: (result: Out, initiator: ChatInitiator) => void | Promise<void>
}

export interface CreateChannelArgs {
  name: string
  visibility?: ChannelVisibility
  /** Becomes `owner` of the new channel (written as a second membership row). Client requests always pass the caller. */
  owner?: string
  metadata?: Record<string, unknown>
}
export interface UpdateChannelArgs {
  id: string
  name?: string
  metadata?: Record<string, unknown>
}
export interface MemberArgs {
  channelId: string
  userId: string
}
export interface AddMemberArgs extends MemberArgs {
  role?: MemberRole
  metadata?: Record<string, unknown>
}
export interface SetMemberRoleArgs extends MemberArgs {
  role: MemberRole
}
export interface SendMessageArgs {
  channelId: string
  authorId: string
  content: unknown
  metadata?: Record<string, unknown>
}
export interface EditMessageArgs {
  id: string
  content?: unknown
  metadata?: Record<string, unknown>
}
export interface StartMessageArgs {
  channelId: string
  authorId: string
  metadata?: Record<string, unknown>
}
export interface FinalizeMessageArgs {
  id: string
  status?: Exclude<MessageStatus, 'streaming'>
  error?: string
}
/** What `finalizeMessage.after` receives: the settled envelope plus every part, assembled. */
export type ChatStreamedMessage = ChatMessage & { parts: ChatMessagePart[] }

/**
 * Domain-layer hooks (PLAN-plugin-chat decision 6): they wrap the operation CORES, so they fire
 * identically for client requests and imperative `chatKit` calls — one extension point that cannot be
 * bypassed. Deletion hooks receive the removed row in `after`.
 */
export interface ChatHooks {
  createChannel?: ChatOpHook<CreateChannelArgs, ChatChannel>
  updateChannel?: ChatOpHook<UpdateChannelArgs, ChatChannel>
  deleteChannel?: ChatOpHook<{ id: string }, ChatChannel>
  joinChannel?: ChatOpHook<MemberArgs, ChatMembership>
  leaveChannel?: ChatOpHook<MemberArgs, ChatMembership>
  addMember?: ChatOpHook<AddMemberArgs, ChatMembership>
  removeMember?: ChatOpHook<MemberArgs, ChatMembership>
  setMemberRole?: ChatOpHook<SetMemberRoleArgs, ChatMembership>
  sendMessage?: ChatOpHook<SendMessageArgs, ChatMessage>
  editMessage?: ChatOpHook<EditMessageArgs, ChatMessage>
  deleteMessage?: ChatOpHook<{ id: string }, ChatMessage>
  /** Gates who may OPEN a stream (rate-limit agents, cap concurrent streams). Appends are hook-free by design. */
  startMessage?: ChatOpHook<StartMessageArgs, ChatMessage>
  /** The moderation/audit point: fires on every settle — complete, aborted (incl. disconnect), and error. */
  finalizeMessage?: ChatOpHook<FinalizeMessageArgs, ChatStreamedMessage>
}

/** Streaming knobs (PLAN-chat-streaming decision 11). Few by design; the defaults are the contract. */
export interface ChatStreamingOptions {
  /** How often an in-flight part's row checkpoints its accumulated text (the late-join floor). Default 1000ms. */
  checkpointMs?: number
  /** Max parts per message (a big supervisor turn-tree ≈ 100). Default 512. */
  maxParts?: number
  /** Max accumulated text bytes per part. Oversize aborts the stream honestly. Default 256 KiB. */
  maxPartBytes?: number
  /** Max events in one append batch. Default 256. */
  maxEventsPerAppend?: number
  /**
   * Derives the envelope's `content` from the final parts at settle. Default: root-lane text parts
   * joined by blank lines (valid for the default `z.string()` content schema); return `undefined`
   * to leave `content` absent. Hosts with a structured content schema MUST supply this.
   */
  project?: (parts: ChatMessagePart[]) => unknown
}

export interface ChatServerOptions<C extends Contract> {
  /** The app contract — must carry BOTH fragments (`plugins: [authContract(), chatContract()]`); throws at startup otherwise. */
  contract: C
  /** Before/after extensions around every domain operation. */
  hooks?: ChatHooks
  /** Streaming-message knobs; see {@link ChatStreamingOptions}. */
  streaming?: ChatStreamingOptions
}

/**
 * A handle on one open streamed message. `push` applies events in order (server-side: no
 * micro-batching needed, there is no wire). ALWAYS settle in a `finally` — kit-initiated streams
 * have no connection whose disconnect could clean them up.
 */
export interface ChatStreamWriter {
  readonly messageId: string
  push(...events: ChatStreamEvent[]): Promise<void>
  finalize(opts?: { status?: Exclude<MessageStatus, 'streaming'>; error?: string }): Promise<ChatMessage>
  abort(error?: string): Promise<ChatMessage>
}

/** Imperative channel management. Like every `chatKit` surface: co-writes fan out live, hooks fire with `initiator.kind: 'server'`. */
export interface ChatChannelsApi {
  /** Create a channel (default `public`). `owner` also writes the owner membership; omit it for a server-run channel. */
  create(input: CreateChannelArgs): Promise<ChatChannel>
  get(id: string): Promise<ChatChannel | undefined>
  find(opts?: { filter?: Expr; limit?: number; offset?: number }): Promise<ChatChannel[]>
  update(id: string, patch: { name?: string; metadata?: Record<string, unknown> }): Promise<ChatChannel>
  /** Cascade-deletes the channel's memberships and messages (FKs are advisory — the plugin owns its own cascade). */
  delete(id: string): Promise<void>
}

export interface ChatMembersApi {
  add(channelId: string, userId: string, opts?: { role?: MemberRole; metadata?: Record<string, unknown> }): Promise<ChatMembership>
  remove(channelId: string, userId: string): Promise<void>
  setRole(channelId: string, userId: string, role: MemberRole): Promise<ChatMembership>
  of(channelId: string): Promise<ChatMembership[]>
  channelsOf(userId: string): Promise<ChatMembership[]>
}

export interface ChatMessagesApi {
  /** `authorId` is always an explicit, real user — provision agents via `authKit.users.create` + `apiKeys.create`. */
  send(input: SendMessageArgs): Promise<ChatMessage>
  edit(id: string, patch: { content?: unknown; metadata?: Record<string, unknown> }): Promise<ChatMessage>
  delete(id: string): Promise<void>
  find(opts?: { filter?: Expr; orderBy?: OrderBy[]; limit?: number; offset?: number }): Promise<ChatMessage[]>
  /** Open a streamed message and get its writer. Settle it in a `finally`. */
  stream(input: StartMessageArgs): Promise<ChatStreamWriter>
  /** The runtime kill-switch (decision 8): abort ANY open stream on this node, whoever owns it. */
  abort(id: string, error?: string): Promise<ChatMessage>
  /** Parts of one message, idx-ordered — the server-side read of a streamed turn. */
  partsOf(messageId: string): Promise<ChatMessagePart[]>
  /**
   * Host-invoked repair for streams orphaned by a CRASHED node (disconnect-abort can't fire there).
   * Never automatic — on a cluster, another node's stream may be mid-flight; only the host knows.
   * Settles `streaming` envelopes with no local stream and no activity for `olderThanMs` as aborted.
   */
  sweepStale(opts: { olderThanMs: number }): Promise<ChatMessage[]>
}

export interface ChatServer {
  /** Register in the server's `plugins: [...]` — the 16 request handlers + read-RLS/write-deny row policies. */
  plugin: SuperLinePlugin<ChatSurface>
  channels: ChatChannelsApi
  members: ChatMembersApi
  messages: ChatMessagesApi
}

const SERVER: ChatInitiator = { kind: 'server' }

/**
 * Build the server half of the chat plugin. Requires plugin-auth on the same server (identity +
 * principals). Wire it as:
 *
 * ```ts
 * const chatKit = chat({ contract: app, hooks: { sendMessage: { before: noSpam } } })
 * createSuperLineServer(app, {
 *   collections: backend,
 *   authenticate: authKit.authenticate,
 *   identify: authKit.identify,             // principal := userId — drives the chat read policies
 *   plugins: [authKit.plugin, chatKit.plugin],
 * })
 * await chatKit.channels.create({ name: 'general' })   // imperative surface (after server creation)
 * ```
 */
export function chat<C extends Contract>(opts: ChatServerOptions<C>): ChatServer {
  const hooks = opts.hooks ?? {}

  // fail fast at startup: both fragments must be merged into the contract
  const declared = new Set(Object.keys((opts.contract as { collections?: Record<string, unknown> }).collections ?? {}))
  for (const need of ['users', 'channels', 'memberships', 'messages', 'messageParts'] as const) {
    if (!declared.has(need))
      throw new Error(
        `plugin-chat: the contract is missing the '${need}' collection — declare plugins: [authContract(), chatContract()] in defineContract`,
      )
  }

  // captured at plugin setup; every read/write below goes through the co-writer so changes fan out live
  let pluginCtx: PluginContext | undefined
  const requireCtx = (): PluginContext => {
    if (!pluginCtx)
      throw new Error(
        'chatKit imperative APIs need the running server — pass chatKit.plugin to createSuperLineServer({ plugins }) first',
      )
    return pluginCtx
  }
  const col = (n: 'channels' | 'memberships' | 'messages' | 'messageParts' | 'users') => requireCtx().collection(n)

  // Per-channel serialization of membership/channel/message mutations. The last-owner guard and the
  // deleteChannel cascade are check-then-act over snapshots (the store has no CAS), so without this two
  // concurrent leaves by co-owners both pass the guard and orphan the channel, and a join/send racing a
  // cascade leaves orphan rows. This closes every single-node interleaving (handlers and the kit share
  // the process); under RELAY CLUSTERING requests on other nodes still interleave — a known v1 caveat.
  const channelLocks = new Map<string, Promise<void>>()
  const withChannelLock = <T>(channelId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = channelLocks.get(channelId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    channelLocks.set(channelId, tail)
    void tail.then(() => {
      if (channelLocks.get(channelId) === tail) channelLocks.delete(channelId)
    })
    return run
  }

  // ── shared lookups ───────────────────────────────────────────────────────────────────────────────

  const mustChannel = async (id: string): Promise<ChatChannel> => {
    const channel = (await col('channels').read(id)) as ChatChannel | undefined
    if (!channel) throw new SuperLineError('NOT_FOUND', `no channel '${id}'`)
    return channel
  }
  const membershipOf = (channelId: string, userId: string) =>
    col('memberships').read(memId(channelId, userId)) as Promise<ChatMembership | undefined>
  const membersOf = (channelId: string) =>
    col('memberships').snapshot({ filter: eq('channelId', channelId) }) as Promise<ChatMembership[]>
  const channelIdsOf = async (userId: string): Promise<string[]> =>
    ((await col('memberships').snapshot({ filter: eq('userId', userId) })) as ChatMembership[]).map((m) => m.channelId)

  /** Client initiators must OWN the channel; the server may do anything. */
  const requireOwner = async (initiator: ChatInitiator, channelId: string): Promise<void> => {
    if (initiator.kind === 'server') return
    const m = await membershipOf(channelId, initiator.userId)
    if (m?.role !== 'owner') throw new SuperLineError('FORBIDDEN', 'only a channel owner can do this')
  }

  /**
   * The last-owner protection (decision 11), applied to client AND server paths: removing/demoting
   * `userId` must not leave a channel with members but zero owners. Promote someone or delete the channel.
   */
  const assertNotLastOwner = async (channelId: string, userId: string): Promise<void> => {
    const members = await membersOf(channelId)
    const target = members.find((m) => m.userId === userId)
    if (target?.role !== 'owner') return
    const remaining = members.filter((m) => m.userId !== userId)
    if (remaining.length > 0 && !remaining.some((m) => m.role === 'owner'))
      throw new SuperLineError(
        'CONFLICT',
        'cannot remove the last owner of a channel that still has members — promote another owner or delete the channel first',
      )
  }

  const runBefore = async <In>(hook: ChatOpHook<In, never> | undefined, input: In, initiator: ChatInitiator): Promise<In> => {
    const out = await (hook as ChatOpHook<In, unknown> | undefined)?.before?.(input, initiator)
    return out === undefined ? input : out
  }

  // ── domain cores — ONE per operation; request handlers and the imperative kit both land here ──────

  const createChannelCore = async (args: CreateChannelArgs, initiator: ChatInitiator): Promise<ChatChannel> => {
    const input = await runBefore(hooks.createChannel, args, initiator)
    const now = Date.now()
    const channel: ChatChannel = {
      id: randomUUID(),
      name: input.name,
      visibility: input.visibility ?? 'public',
      createdBy: initiator.kind === 'client' ? initiator.userId : null,
      createdAt: now,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    await col('channels').insert(channel)
    // two co-writes, not one transaction: a crash in between leaves an owner-less channel the kit can
    // repair — accepted for v1 (the co-writer has no cross-collection batch)
    if (input.owner) {
      await col('memberships').insert({
        id: memId(channel.id, input.owner),
        channelId: channel.id,
        userId: input.owner,
        role: 'owner',
        addedBy: null,
        createdAt: now,
      } satisfies ChatMembership)
    }
    await hooks.createChannel?.after?.(channel, initiator)
    return channel
  }

  const updateChannelCore = async (args: UpdateChannelArgs, initiator: ChatInitiator): Promise<ChatChannel> => {
    const input = await runBefore(hooks.updateChannel, args, initiator)
    await requireOwner(initiator, input.id)
    const channel = await mustChannel(input.id)
    const next: ChatChannel = {
      ...channel,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }
    await col('channels').update(next)
    await hooks.updateChannel?.after?.(next, initiator)
    return next
  }

  const deleteChannelCore = async (args: { id: string }, initiator: ChatInitiator): Promise<ChatChannel> => {
    const input = await runBefore(hooks.deleteChannel, args, initiator)
    const channel = await withChannelLock(input.id, async () => {
      await requireOwner(initiator, input.id)
      const target = await mustChannel(input.id)
      // cascade order: channel first (new sends start failing NOT_FOUND), then memberships, then messages;
      // the lock keeps a concurrent join/send from slipping rows in behind the cascade's snapshots
      await col('channels').delete(target.id)
      const members = await membersOf(target.id)
      await Promise.all(members.map((m) => col('memberships').delete(m.id)))
      const msgs = (await col('messages').snapshot({ filter: eq('channelId', target.id) })) as ChatMessage[]
      await Promise.all(msgs.map((m) => col('messages').delete(m.id)))
      // local open streams die with the channel — each drop rides its stream's LANE so in-flight
      // append batches complete before the parts snapshot below, and get swept with the rest
      const doomed = [...streams.values()].filter((s) => s.channelId === target.id)
      await Promise.all(doomed.map((s) => onLane(s, async () => dropStream(s))))
      const parts = (await col('messageParts').snapshot({ filter: eq('channelId', target.id) })) as ChatMessagePart[]
      await Promise.all(parts.map((p) => col('messageParts').delete(p.id)))
      const room = requireCtx().room(streamRoom(target.id))
      for (const c of room.connections) room.remove(c)
      return target
    })
    await hooks.deleteChannel?.after?.(channel, initiator)
    return channel
  }

  const joinChannelCore = async (args: MemberArgs, initiator: ChatInitiator): Promise<ChatMembership> => {
    const input = await runBefore(hooks.joinChannel, args, initiator)
    const membership = await withChannelLock(input.channelId, async () => {
      const channel = (await col('channels').read(input.channelId)) as ChatChannel | undefined
      if (!channel) throw new SuperLineError('NOT_FOUND', `no channel '${input.channelId}'`)
      if (await membershipOf(input.channelId, input.userId)) throw new SuperLineError('CONFLICT', 'already a member')
      // a private channel is join-by-invitation only; answer NOT_FOUND so probing can't confirm it exists
      if (channel.visibility !== 'public') throw new SuperLineError('NOT_FOUND', `no channel '${input.channelId}'`)
      const row: ChatMembership = {
        id: memId(input.channelId, input.userId),
        channelId: input.channelId,
        userId: input.userId,
        role: 'member',
        addedBy: null,
        createdAt: Date.now(),
      }
      await col('memberships').insert(row)
      return row
    })
    await hooks.joinChannel?.after?.(membership, initiator)
    return membership
  }

  const leaveChannelCore = async (args: MemberArgs, initiator: ChatInitiator): Promise<ChatMembership> => {
    const input = await runBefore(hooks.leaveChannel, args, initiator)
    const membership = await withChannelLock(input.channelId, async () => {
      const row = await membershipOf(input.channelId, input.userId)
      if (!row) throw new SuperLineError('NOT_FOUND', 'not a member of this channel')
      await assertNotLastOwner(input.channelId, input.userId)
      await col('memberships').delete(row.id)
      return row
    })
    // self-leave doesn't disconnect (unlike removeMember) — evict the leaver's LOCAL conns from the
    // delta room so an ex-member stops receiving ephemeral text; conns on other nodes unwatch
    // client-side on the membership row delta (v1 caveat, same relay-clustering note as the locks)
    evictFromStreamRoom(input.channelId, input.userId)
    await hooks.leaveChannel?.after?.(membership, initiator)
    return membership
  }

  const addMemberCore = async (args: AddMemberArgs, initiator: ChatInitiator): Promise<ChatMembership> => {
    const input = await runBefore(hooks.addMember, args, initiator)
    const membership = await withChannelLock(input.channelId, async () => {
      await requireOwner(initiator, input.channelId)
      await mustChannel(input.channelId)
      const target = await col('users').read(input.userId)
      if (!target) throw new SuperLineError('NOT_FOUND', `no user '${input.userId}'`)
      if (await membershipOf(input.channelId, input.userId)) throw new SuperLineError('CONFLICT', 'already a member')
      const row: ChatMembership = {
        id: memId(input.channelId, input.userId),
        channelId: input.channelId,
        userId: input.userId,
        role: input.role ?? 'member',
        addedBy: initiator.kind === 'client' ? initiator.userId : null,
        createdAt: Date.now(),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }
      await col('memberships').insert(row)
      return row
    })
    await hooks.addMember?.after?.(membership, initiator)
    return membership
  }

  const removeMemberCore = async (args: MemberArgs, initiator: ChatInitiator): Promise<ChatMembership> => {
    const input = await runBefore(hooks.removeMember, args, initiator)
    const membership = await withChannelLock(input.channelId, async () => {
      await requireOwner(initiator, input.channelId)
      const row = await membershipOf(input.channelId, input.userId)
      if (!row) throw new SuperLineError('NOT_FOUND', 'not a member of this channel')
      await assertNotLastOwner(input.channelId, input.userId)
      await col('memberships').delete(row.id)
      return row
    })
    // cut the kicked member's LIVE subscriptions too: captured read filters are only re-evaluated on
    // (re)subscribe, so without this a removed member keeps receiving the channel's traffic. The client
    // auto-reconnects and re-subscribes against the new membership state.
    requireCtx().toUser(input.userId).disconnect()
    await hooks.removeMember?.after?.(membership, initiator)
    return membership
  }

  const setMemberRoleCore = async (args: SetMemberRoleArgs, initiator: ChatInitiator): Promise<ChatMembership> => {
    const input = await runBefore(hooks.setMemberRole, args, initiator)
    const { next, changed } = await withChannelLock(input.channelId, async () => {
      await requireOwner(initiator, input.channelId)
      const membership = await membershipOf(input.channelId, input.userId)
      if (!membership) throw new SuperLineError('NOT_FOUND', 'not a member of this channel')
      if (membership.role === input.role) return { next: membership, changed: false }
      // demotion guard — DISTINCT from assertNotLastOwner: the demoted target REMAINS a member, so
      // demoting the last owner always leaves members with zero owners (even a sole-member channel)
      if (input.role === 'member') {
        const members = await membersOf(input.channelId)
        if (!members.some((m) => m.userId !== input.userId && m.role === 'owner'))
          throw new SuperLineError('CONFLICT', 'cannot demote the last owner — promote another owner first')
      }
      const row: ChatMembership = { ...membership, role: input.role }
      await col('memberships').update(row)
      return { next: row, changed: true }
    })
    if (changed) await hooks.setMemberRole?.after?.(next, initiator)
    return next
  }

  // Strictly-monotonic message stamps (per node): a same-ms burst would otherwise tie on createdAt and
  // make createdAt-ordered windows arbitrary. Server-authoritative timestamps make this possible at all.
  let lastStamp = 0
  const messageStamp = (): number => (lastStamp = Math.max(Date.now(), lastStamp + 1))

  const sendMessageCore = async (args: SendMessageArgs, initiator: ChatInitiator): Promise<ChatMessage> => {
    const input = await runBefore(hooks.sendMessage, args, initiator)
    const message = await withChannelLock(input.channelId, async () => {
      await mustChannel(input.channelId)
      // membership is required for EVERY send — server included — so "every author was a member" holds;
      // add your agent to the channel first (chatKit.members.add)
      if (!(await membershipOf(input.channelId, input.authorId)))
        throw new SuperLineError('FORBIDDEN', 'the author is not a member of this channel')
      const row: ChatMessage = {
        id: randomUUID(),
        channelId: input.channelId,
        authorId: input.authorId,
        content: input.content,
        createdAt: messageStamp(),
        editedAt: null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }
      await col('messages').insert(row) // schema-validated: the HOST's content schema runs right here
      return row
    })
    await hooks.sendMessage?.after?.(message, initiator)
    return message
  }

  /** Client edit/delete: author-only AND still a member (matching the "author ∧ member" write rule). */
  const requireAuthor = async (initiator: ChatInitiator, message: ChatMessage, verb: string): Promise<void> => {
    if (initiator.kind === 'server') return
    if (message.authorId !== initiator.userId)
      throw new SuperLineError('FORBIDDEN', `only the author can ${verb} a message`)
    if (!(await membershipOf(message.channelId, initiator.userId)))
      throw new SuperLineError('FORBIDDEN', 'not a member of this channel')
  }

  const editMessageCore = async (args: EditMessageArgs, initiator: ChatInitiator): Promise<ChatMessage> => {
    const input = await runBefore(hooks.editMessage, args, initiator)
    const message = (await col('messages').read(input.id)) as ChatMessage | undefined
    if (!message) throw new SuperLineError('NOT_FOUND', `no message '${input.id}'`)
    await requireAuthor(initiator, message, 'edit')
    const next: ChatMessage = {
      ...message,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      editedAt: Date.now(),
    }
    await col('messages').update(next)
    await hooks.editMessage?.after?.(next, initiator)
    return next
  }

  const deleteMessageCore = async (args: { id: string }, initiator: ChatInitiator): Promise<ChatMessage> => {
    const input = await runBefore(hooks.deleteMessage, args, initiator)
    const message = (await col('messages').read(input.id)) as ChatMessage | undefined
    if (!message) throw new SuperLineError('NOT_FOUND', `no message '${input.id}'`)
    await requireAuthor(initiator, message, 'delete')
    // a still-open local stream dies with its message (no settle writes — the rows go away). The
    // drop rides the stream's LANE so an in-flight append batch completes first — its parts land
    // before the cascade snapshot below and are cleaned up with the rest, never orphaned.
    const open = streams.get(message.id)
    if (open) await onLane(open, async () => dropStream(open))
    await col('messages').delete(message.id) // hard delete (decision 7) — archive in a before hook if needed
    const parts = (await col('messageParts').snapshot({ filter: eq('messageId', message.id) })) as ChatMessagePart[]
    await Promise.all(parts.map((p) => col('messageParts').delete(p.id)))
    await hooks.deleteMessage?.after?.(message, initiator)
    return message
  }

  // ── streaming engine (PLAN-chat-streaming) ────────────────────────────────────────────────────────
  //
  // Node-local state per open stream: the ingress node that ran startMessage owns the accumulators
  // and the part-key→idx map, so appends must arrive on it (they do — same author connection). The
  // durable floor rides the part rows (checkpoints); the smooth preview rides room-broadcast deltas.

  const scfg = {
    checkpointMs: opts.streaming?.checkpointMs ?? 1000,
    maxParts: opts.streaming?.maxParts ?? 512,
    maxPartBytes: opts.streaming?.maxPartBytes ?? 256 * 1024,
    maxEventsPerAppend: opts.streaming?.maxEventsPerAppend ?? 256,
    project:
      opts.streaming?.project ??
      ((parts: ChatMessagePart[]): unknown => {
        const texts = parts.filter((p) => p.type === 'text' && p.parent === null).map((p) => p.text)
        return texts.length > 0 ? texts.join('\n\n') : undefined
      }),
  }

  const streamRoom = (channelId: string): string => `chat:ch:${channelId}`

  const evictFromStreamRoom = (channelId: string, userId: string): void => {
    const room = requireCtx().room(streamRoom(channelId))
    for (const c of room.connections) if ((c.ctx as AuthContext | undefined)?.userId === userId) room.remove(c)
  }

  interface LivePart {
    idx: number
    type: PartType
    parent: string | null
    text: string
    done: boolean
    dirty: boolean
    toolCallId?: string
    toolName?: string
    args?: unknown
    result?: unknown
    isError?: boolean
    state?: ToolState
  }
  interface OpenStream {
    messageId: string
    channelId: string
    authorId: string
    /** The STARTING connection owns the stream lifetime (disconnect-abort); absent on kit streams. */
    connId?: string
    parts: Map<string, LivePart>
    nextIdx: number
    /** Per-message serialization: appends/flushes/settle apply strictly in order. */
    lane: Promise<void>
    flushTimer?: ReturnType<typeof setTimeout>
    lastCheckpointAt: number
  }

  const streams = new Map<string, OpenStream>()
  const connStreams = new Map<string, Set<string>>()

  const onLane = <T>(s: OpenStream, fn: () => Promise<T>): Promise<T> => {
    const run = s.lane.then(fn, fn)
    s.lane = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const dropStream = (s: OpenStream): void => {
    streams.delete(s.messageId)
    if (s.connId) connStreams.get(s.connId)?.delete(s.messageId)
    if (s.flushTimer) clearTimeout(s.flushTimer)
  }

  const partRowOf = (s: OpenStream, p: LivePart, now: number): ChatMessagePart => ({
    id: partId(s.messageId, p.idx),
    messageId: s.messageId,
    channelId: s.channelId,
    idx: p.idx,
    type: p.type,
    parent: p.parent,
    text: p.text,
    offset: p.text.length, // a row's offset is ALWAYS its own text length — that's the checkpoint contract
    done: p.done,
    lastActivityAt: now,
    ...(p.toolCallId !== undefined ? { toolCallId: p.toolCallId } : {}),
    ...(p.toolName !== undefined ? { toolName: p.toolName } : {}),
    ...(p.args !== undefined ? { args: p.args } : {}),
    ...(p.result !== undefined ? { result: p.result } : {}),
    ...(p.isError !== undefined ? { isError: p.isError } : {}),
    ...(p.state !== undefined ? { state: p.state } : {}),
  })

  const flushPart = async (s: OpenStream, p: LivePart): Promise<void> => {
    await col('messageParts').update(partRowOf(s, p, Date.now()))
    p.dirty = false
  }

  // Trailing flush: if deltas stop arriving (tool wait, model pause), the last accumulated tail
  // still checkpoints within checkpointMs — a late joiner is never more than one interval behind.
  // A failed background flush self-heals at the next flush/settle, so it is deliberately swallowed.
  const scheduleFlush = (s: OpenStream): void => {
    if (s.flushTimer) return
    const t = setTimeout(() => {
      s.flushTimer = undefined
      if (streams.get(s.messageId) !== s) return
      void onLane(s, async () => {
        if (streams.get(s.messageId) !== s) return // settled while queued — never write behind a settle
        for (const p of s.parts.values()) if (p.dirty && !p.done) await flushPart(s, p)
      }).catch(() => {})
    }, scfg.checkpointMs)
    t.unref?.()
    s.flushTimer = t
  }

  /**
   * Settle on the lane (callers hold it). The stream leaves the map only AFTER its writes land:
   * a transient backend failure mid-settle leaves the stream open and RETRYABLE (not a zombie
   * 'streaming' row behind a lying CONFLICT), and sweepStale can never race a settle in progress —
   * it sees the stream as live until the row writes are durable. Double-settle is impossible: the
   * lane serializes, and the second attempt fails the identity guard once the first dropped it.
   */
  const settle = async (
    s: OpenStream,
    status: Exclude<MessageStatus, 'streaming'>,
    error?: string,
  ): Promise<ChatStreamedMessage> => {
    if (streams.get(s.messageId) !== s) throw new SuperLineError('CONFLICT', 'stream already settled')
    const now = Date.now()
    const current = (await col('messages').read(s.messageId)) as ChatMessage | undefined
    const parts: ChatMessagePart[] = []
    for (const p of [...s.parts.values()].sort((a, b) => a.idx - b.idx)) {
      p.done = true
      const row = partRowOf(s, p, now)
      parts.push(row)
      if (current) await col('messageParts').update(row)
    }
    if (!current) {
      // message deleted mid-stream (cascade race) — nothing durable left to update
      dropStream(s)
      return { id: s.messageId, channelId: s.channelId, authorId: s.authorId, createdAt: 0, editedAt: null, status, parts }
    }
    // status first (always schema-valid — the message is settled even if the projection isn't),
    // content second so a bad projection fails loudly WITHOUT leaving a zombie 'streaming' row
    let next: ChatMessage = { ...current, status, ...(error !== undefined ? { error } : {}) }
    await col('messages').update(next)
    dropStream(s) // the row is durably settled — NOW the stream is gone; a bad projection below is not retryable
    const content = scfg.project(parts)
    if (content !== undefined) {
      next = { ...next, content }
      try {
        await col('messages').update(next)
      } catch (e) {
        throw new SuperLineError(
          'VALIDATION',
          `the finalize projection did not validate against the host content schema — supply chat({ streaming: { project } }): ${(e as Error).message}`,
        )
      }
    }
    return { ...next, parts }
  }

  /**
   * The unvetoable settle path — disconnect-abort, the kit kill-switch, cap violations, and
   * shutdown drain. Skips `finalizeMessage.before` (hooks gate INTENT; cleanup must always run);
   * `finalizeMessage.after` still fires so audit never misses an interrupted turn. Returns
   * undefined when no local stream exists.
   */
  const forceAbort = async (id: string, error: string): Promise<ChatStreamedMessage | undefined> => {
    const s = streams.get(id)
    if (!s) return undefined
    const settled = await onLane(s, () => settle(s, 'aborted', error))
    try {
      await hooks.finalizeMessage?.after?.(settled, SERVER)
    } catch {
      // an observing hook must not fail cleanup
    }
    return settled
  }

  /** A cap violation settles the stream as aborted, then surfaces the violation to the producer. */
  const abortForViolation = async (s: OpenStream, reason: string): Promise<never> => {
    const settled = await settle(s, 'aborted', reason).catch(() => undefined)
    if (settled) {
      try {
        await hooks.finalizeMessage?.after?.(settled, SERVER)
      } catch {
        // the violation is the caller's error; an after-hook throw must not mask it
      }
    }
    throw new SuperLineError('BAD_REQUEST', reason)
  }

  const applyEvent = async (s: OpenStream, e: ChatStreamEvent): Promise<void> => {
    const now = Date.now()
    if (e.type === 'part_start') {
      if (s.parts.has(e.key)) throw new SuperLineError('CONFLICT', `part '${e.key}' already started`)
      if (s.parts.size >= scfg.maxParts) return abortForViolation(s, `too many parts (maxParts ${scfg.maxParts})`)
      let parent: string | null = null
      if (e.parent !== undefined) {
        let anchor: LivePart | undefined
        for (const p of s.parts.values()) if (p.type === 'tool' && p.toolCallId === e.parent) anchor = p
        if (!anchor)
          throw new SuperLineError('BAD_REQUEST', `parent '${e.parent}' is not a tool part of this message`)
        parent = e.parent
      }
      const p: LivePart = {
        idx: s.nextIdx++,
        type: e.partType,
        parent,
        text: '',
        done: false,
        dirty: false,
        // a tool part's key IS its toolCallId (decision 4); args stream nowhere — they land whole.
        // toolName is tool-only: on text/reasoning parts it would corrupt the row shape clients
        // key their renderers on, so it is dropped rather than stored.
        ...(e.partType === 'tool'
          ? { toolCallId: e.key, state: 'input-streaming' as ToolState, ...(e.toolName !== undefined ? { toolName: e.toolName } : {}) }
          : {}),
      }
      s.parts.set(e.key, p)
      await col('messageParts').insert(partRowOf(s, p, now))
      return
    }
    const p = s.parts.get(e.key)
    if (!p) throw new SuperLineError('BAD_REQUEST', `no part '${e.key}' — send part_start first`)
    if (p.done) throw new SuperLineError('CONFLICT', `part '${e.key}' already ended`)
    if (e.type === 'delta') {
      if (p.type === 'tool')
        throw new SuperLineError('BAD_REQUEST', 'deltas apply to text/reasoning parts; tool args land whole via part_patch')
      if (p.text.length + e.text.length > scfg.maxPartBytes)
        return abortForViolation(s, `part '${e.key}' exceeds maxPartBytes (${scfg.maxPartBytes})`)
      const offset = p.text.length
      p.text += e.text
      p.dirty = true
      requireCtx()
        .room(streamRoom(s.channelId))
        .broadcast('chat.streamDelta', {
          channelId: s.channelId,
          messageId: s.messageId,
          partIdx: p.idx,
          offset,
          text: e.text,
        })
      if (now - s.lastCheckpointAt >= scfg.checkpointMs) {
        s.lastCheckpointAt = now
        await flushPart(s, p)
      } else {
        scheduleFlush(s)
      }
      return
    }
    if (e.type === 'part_patch') {
      if (p.type !== 'tool') throw new SuperLineError('BAD_REQUEST', 'part_patch applies to tool parts')
      if (e.args !== undefined) p.args = e.args
      if (e.result !== undefined) p.result = e.result
      if (e.isError !== undefined) p.isError = e.isError
      // state is MONOTONIC (input-streaming → running → done): a stale/out-of-order patch can never
      // regress a part behind a landed result into an incoherent {state:'running', result} row
      const rank: Record<ToolState, number> = { 'input-streaming': 0, running: 1, done: 2 }
      const proposed: ToolState | undefined =
        e.state ?? (e.result !== undefined ? 'done' : e.args !== undefined ? 'running' : undefined)
      if (proposed !== undefined && rank[proposed] > rank[p.state ?? 'input-streaming']) p.state = proposed
      await flushPart(s, p) // lifecycle edges are rare and load-bearing — always persist immediately
      return
    }
    // part_end — optional authoritative full-text replace (a lost delta self-heals here)
    if (e.text !== undefined) {
      if (e.text.length > scfg.maxPartBytes)
        return abortForViolation(s, `part '${e.key}' exceeds maxPartBytes (${scfg.maxPartBytes})`)
      p.text = e.text
    }
    p.done = true
    if (p.type === 'tool' && p.state !== 'done') p.state = 'done'
    await flushPart(s, p)
  }

  const startMessageCore = async (
    args: StartMessageArgs & { connId?: string },
    initiator: ChatInitiator,
  ): Promise<ChatMessage> => {
    const input = await runBefore(hooks.startMessage, args, initiator)
    const message = await withChannelLock(input.channelId, async () => {
      await mustChannel(input.channelId)
      if (!(await membershipOf(input.channelId, input.authorId)))
        throw new SuperLineError('FORBIDDEN', 'the author is not a member of this channel')
      const row: ChatMessage = {
        id: randomUUID(),
        channelId: input.channelId,
        authorId: input.authorId,
        createdAt: messageStamp(),
        editedAt: null,
        status: 'streaming',
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }
      await col('messages').insert(row) // no content — the envelope stays quiet until finalize
      return row
    })
    const s: OpenStream = {
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.authorId,
      ...(args.connId !== undefined ? { connId: args.connId } : {}),
      parts: new Map(),
      nextIdx: 0,
      lane: Promise.resolve(),
      lastCheckpointAt: Date.now(),
    }
    streams.set(message.id, s)
    if (args.connId !== undefined) {
      let set = connStreams.get(args.connId)
      if (!set) connStreams.set(args.connId, (set = new Set()))
      set.add(message.id)
    }
    await hooks.startMessage?.after?.(message, initiator)
    return message
  }

  const requireStream = (id: string, initiator: ChatInitiator): OpenStream => {
    const s = streams.get(id)
    if (!s)
      throw new SuperLineError(
        'CONFLICT',
        `no open stream for message '${id}' — settled, unknown, or owned by another node`,
      )
    if (initiator.kind === 'client' && s.authorId !== initiator.userId)
      throw new SuperLineError('FORBIDDEN', 'only the author can write to a stream')
    return s
  }

  const appendMessageCore = async (
    args: { id: string; events: ChatStreamEvent[] },
    initiator: ChatInitiator,
  ): Promise<void> => {
    const s = requireStream(args.id, initiator)
    await onLane(s, async () => {
      if (streams.get(s.messageId) !== s) throw new SuperLineError('CONFLICT', 'stream already settled')
      if (args.events.length > scfg.maxEventsPerAppend)
        return abortForViolation(s, `append batch exceeds maxEventsPerAppend (${scfg.maxEventsPerAppend})`)
      for (const e of args.events) await applyEvent(s, e)
    })
  }

  const finalizeMessageCore = async (args: FinalizeMessageArgs, initiator: ChatInitiator): Promise<ChatStreamedMessage> => {
    const input = await runBefore(hooks.finalizeMessage, args, initiator)
    const s = requireStream(input.id, initiator)
    const result = await onLane(s, () => settle(s, input.status ?? 'complete', input.error))
    await hooks.finalizeMessage?.after?.(result, initiator)
    return result
  }

  const makeWriter = (messageId: string): ChatStreamWriter => ({
    messageId,
    push: async (...events) => {
      await appendMessageCore({ id: messageId, events }, SERVER)
    },
    finalize: (o = {}) =>
      finalizeMessageCore(
        { id: messageId, ...(o.status !== undefined ? { status: o.status } : {}), ...(o.error !== undefined ? { error: o.error } : {}) },
        SERVER,
      ),
    abort: async (error) => {
      // producer-side cleanup, not intent — unvetoable like every other abort path
      const settled = await forceAbort(messageId, error ?? 'aborted by producer')
      if (!settled) throw new SuperLineError('CONFLICT', 'stream already settled')
      return settled
    },
  })

  // ── the plugin: policies (read-RLS, write-deny) + the 16 request handlers ─────────────────────────

  /** Matches nothing — the deny filter for guests (no signed-in user ⇒ no chat visibility). */
  const NONE: Expr = isIn('id', [])
  /**
   * The signed-in user behind a connection, from the AuthContext — NOT from `principal`: the runtime
   * falls `principal` back to the connection id (always a string), so keying a guest-deny on it is dead
   * code. `ctx.userId` is null exactly when the connection is a guest.
   */
  const uidOf = (ctx: unknown): string | null => (ctx as AuthContext | undefined)?.userId ?? null

  const plugin: SuperLinePlugin<ChatSurface> = {
    name: 'chat',
    setup: (ctx) => {
      pluginCtx = ctx
      // graceful shutdown drains open LOCAL streams while the backend/adapter are still live —
      // a clean close() must not strand 'streaming' rows (that failure mode is reserved for crashes)
      return async () => {
        await Promise.all([...streams.keys()].map((id) => forceAbort(id, 'server shutdown').catch(() => {})))
      }
    },
    policies: {
      // collections are the READ side only; every write goes through a request → co-writer (decision 5)
      channels: {
        read: async (_principal: string, ctx: unknown) => {
          const uid = uidOf(ctx)
          return uid ? or(eq('visibility', 'public'), isIn('id', await channelIdsOf(uid))) : NONE
        },
      },
      memberships: {
        // own rows (STABLE — the client half's re-subscribe trigger) ∪ rows of channels you're in
        read: async (_principal: string, ctx: unknown) => {
          const uid = uidOf(ctx)
          return uid ? or(eq('userId', uid), isIn('channelId', await channelIdsOf(uid))) : NONE
        },
      },
      messages: {
        read: async (_principal: string, ctx: unknown) => {
          const uid = uidOf(ctx)
          return uid ? isIn('channelId', await channelIdsOf(uid)) : NONE
        },
      },
      messageParts: {
        // same membership scope as messages — the denormalized channelId column exists for this
        read: async (_principal: string, ctx: unknown) => {
          const uid = uidOf(ctx)
          return uid ? isIn('channelId', await channelIdsOf(uid)) : NONE
        },
      },
    },
    onDisconnect: (conn) => {
      // disconnect-abort (decision 7): the starting connection owns the stream lifetime; partial
      // content is preserved and finalizeMessage.after fires — audit never misses an interrupted
      // turn. forceAbort, not the core: a host's finalizeMessage.before must not veto cleanup
      // (a swallowed veto here would leak the stream forever — sweepStale skips live-looking ids).
      const ids = connStreams.get(conn.id)
      if (!ids) return
      connStreams.delete(conn.id)
      for (const id of ids) void forceAbort(id, 'author disconnected').catch(() => {})
    },
    handlers: () => {
      const asUser = (connCtx: unknown): ChatInitiator & { kind: 'client' } => {
        const { userId } = connCtx as AuthContext
        if (!userId) throw new SuperLineError('UNAUTHORIZED', 'sign in to use chat')
        return { kind: 'client', userId }
      }
      return {
        createChannel: async (input, connCtx) => {
          const initiator = asUser(connCtx)
          return createChannelCore({ ...input, owner: initiator.userId }, initiator)
        },
        updateChannel: async (input, connCtx) => updateChannelCore(input, asUser(connCtx)),
        deleteChannel: async (input, connCtx) => {
          await deleteChannelCore(input, asUser(connCtx))
          return { ok: true }
        },
        joinChannel: async (input, connCtx) => {
          const initiator = asUser(connCtx)
          return joinChannelCore({ channelId: input.channelId, userId: initiator.userId }, initiator)
        },
        leaveChannel: async (input, connCtx) => {
          const initiator = asUser(connCtx)
          await leaveChannelCore({ channelId: input.channelId, userId: initiator.userId }, initiator)
          return { ok: true }
        },
        addMember: async (input, connCtx) => addMemberCore(input, asUser(connCtx)),
        removeMember: async (input, connCtx) => {
          await removeMemberCore(input, asUser(connCtx))
          return { ok: true }
        },
        setMemberRole: async (input, connCtx) => setMemberRoleCore(input, asUser(connCtx)),
        sendMessage: async (input, connCtx) => {
          const initiator = asUser(connCtx)
          // built explicitly: z.unknown() infers `content` as an optional key, but the core requires it
          return sendMessageCore(
            {
              channelId: input.channelId,
              authorId: initiator.userId,
              content: input.content,
              ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            },
            initiator,
          )
        },
        editMessage: async (input, connCtx) => editMessageCore(input, asUser(connCtx)),
        deleteMessage: async (input, connCtx) => {
          await deleteMessageCore(input, asUser(connCtx))
          return { ok: true }
        },
        startMessage: async (input, connCtx, conn) => {
          const initiator = asUser(connCtx)
          return startMessageCore(
            {
              channelId: input.channelId,
              authorId: initiator.userId,
              connId: conn.id,
              ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            },
            initiator,
          )
        },
        appendMessage: async (input, connCtx) => {
          await appendMessageCore({ id: input.id, events: input.events as ChatStreamEvent[] }, asUser(connCtx))
          return { ok: true }
        },
        finalizeMessage: async (input, connCtx) => {
          // strip the assembled parts — the wire output is the message schema, viewers read parts rows
          const { parts: _parts, ...message } = await finalizeMessageCore(input, asUser(connCtx))
          return message
        },
        watchChannel: async (input, connCtx, conn) => {
          const initiator = asUser(connCtx)
          if (!(await membershipOf(input.channelId, initiator.userId)))
            throw new SuperLineError('FORBIDDEN', 'not a member of this channel')
          requireCtx().room(streamRoom(input.channelId)).add(conn)
          return { ok: true }
        },
        unwatchChannel: async (input, _connCtx, conn) => {
          // no gate: removing a conn from a room it may not be in is a harmless no-op
          requireCtx().room(streamRoom(input.channelId)).remove(conn)
          return { ok: true }
        },
      }
    },
  }

  // ── the imperative kit — the same cores with initiator 'server' ───────────────────────────────────

  const channels: ChatChannelsApi = {
    create: (input) => createChannelCore(input, SERVER),
    get: async (id) => (await col('channels').read(id)) as ChatChannel | undefined,
    find: async (opts = {}) =>
      (await col('channels').snapshot({
        ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      })) as ChatChannel[],
    update: (id, patch) => updateChannelCore({ id, ...patch }, SERVER),
    delete: async (id) => void (await deleteChannelCore({ id }, SERVER)),
  }

  const members: ChatMembersApi = {
    add: (channelId, userId, opts = {}) => addMemberCore({ channelId, userId, ...opts }, SERVER),
    remove: async (channelId, userId) => void (await removeMemberCore({ channelId, userId }, SERVER)),
    setRole: (channelId, userId, role) => setMemberRoleCore({ channelId, userId, role }, SERVER),
    of: (channelId) => membersOf(channelId),
    channelsOf: async (userId) =>
      (await col('memberships').snapshot({ filter: eq('userId', userId) })) as ChatMembership[],
  }

  const messages: ChatMessagesApi = {
    send: (input) => sendMessageCore(input, SERVER),
    edit: (id, patch) => editMessageCore({ id, ...patch }, SERVER),
    delete: async (id) => void (await deleteMessageCore({ id }, SERVER)),
    find: async (opts = {}) =>
      (await col('messages').snapshot({
        ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
        ...(opts.orderBy !== undefined ? { orderBy: opts.orderBy } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      })) as ChatMessage[],
    stream: async (input) => {
      const message = await startMessageCore(input, SERVER)
      return makeWriter(message.id)
    },
    abort: async (id, error) => {
      // the kill-switch is UNVETOABLE (decision 8): forceAbort skips finalizeMessage.before
      const settled = await forceAbort(id, error ?? 'aborted by server')
      if (!settled)
        throw new SuperLineError(
          'CONFLICT',
          `no open stream for message '${id}' — settled, unknown, or owned by another node`,
        )
      return settled
    },
    partsOf: async (messageId) =>
      ((await col('messageParts').snapshot({ filter: eq('messageId', messageId) })) as ChatMessagePart[]).sort(
        (a, b) => a.idx - b.idx,
      ),
    sweepStale: async ({ olderThanMs }) => {
      const cutoff = Date.now() - olderThanMs
      const rows = (await col('messages').snapshot({ filter: eq('status', 'streaming') })) as ChatMessage[]
      const swept: ChatMessage[] = []
      for (const m of rows) {
        if (streams.has(m.id)) continue // live on THIS node — another node's liveness is the host's call
        const parts = ((await col('messageParts').snapshot({ filter: eq('messageId', m.id) })) as ChatMessagePart[]).sort(
          (a, b) => a.idx - b.idx,
        )
        const lastActivity = Math.max(m.createdAt, ...parts.map((p) => p.lastActivityAt))
        if (lastActivity > cutoff) continue
        for (const p of parts) if (!p.done) await col('messageParts').update({ ...p, done: true })
        let next: ChatMessage = { ...m, status: 'aborted', error: 'stream orphaned (swept)' }
        await col('messages').update(next)
        const content = scfg.project(parts.map((p) => (p.done ? p : { ...p, done: true })))
        if (content !== undefined) {
          // best-effort: a projection the host schema rejects must not fail the whole sweep
          const withContent: ChatMessage = { ...next, content }
          try {
            await col('messages').update(withContent)
            next = withContent
          } catch {
            // status write above already settled the row — content stays absent
          }
        }
        swept.push(next)
      }
      return swept
    },
  }

  return { plugin, channels, members, messages }
}

// ── bot provisioning (PLAN-chat-mastra) ───────────────────────────────────────────────────────────

/** The slice of plugin-auth's kit `provisionChatBot` drives — structural, so any auth-shaped host fits. */
export interface ProvisionBotAuthKit {
  users: {
    find(opts?: { filter?: Expr; includeDeactivated?: boolean }): Promise<AuthUser[]>
    create(input: {
      email: string
      displayName: string
      roles?: string[]
      metadata?: Record<string, unknown>
    }): Promise<AuthUser>
    reactivate(id: string): Promise<void>
  }
  apiKeys: {
    create(userId: string, opts: { role: string; label: string }): Promise<{ id: string; key: string }>
    listFor(userId: string): Promise<{ id: string; label?: string }[]>
    revoke(id: string): Promise<void>
  }
}

export interface ProvisionChatBotOptions {
  /**
   * The bot's display name — the find-or-create identity key. (The public users row carries no
   * email; that lives in the deny-all credentials collection, so the name is the one readable
   * stable key.) Keep it unique among your bots.
   */
  name: string
  /** The account email, used at first creation only. Default: `<slug(name)>@bots.local`. */
  email?: string
  /** The API key's connect role. Default `'user'`. */
  role?: string
  /** Same-label keys are revoked and re-minted each call, so restarts don't accumulate live keys. Default `<slug(name)>-bot`. */
  keyLabel?: string
  /** User metadata on first creation. `bot: true` is always added — it's the adoption marker. */
  metadata?: Record<string, unknown>
  /** Channel ids to join as a member (idempotent — already-a-member is fine). */
  channels?: string[]
}

/**
 * Idempotent bot identity: find-or-create the user by display name (reactivating a soft-deleted
 * one), revoke + re-mint its same-label API key, and join the given channels. Passwordless — the
 * bot connects with the returned `apiKey` only. Call it once per process start:
 *
 * ```ts
 * const { user, apiKey } = await provisionChatBot(authKit, chatKit, { name: 'Supervisor' })
 * const client = createSuperLineClient(app, { transport, role: 'user', params: { apiKey } })
 * const bot = chatClient(client, { userId: user.id })
 * ```
 *
 * Revoke-then-mint is not atomic: a rolling multi-instance restart can transiently hold two live
 * keys under one label. Fine for the intended one-process-per-bot shape.
 */
export async function provisionChatBot(
  authKit: ProvisionBotAuthKit,
  chatKit: { members: Pick<ChatMembersApi, 'add'> },
  opts: ProvisionChatBotOptions,
): Promise<{ user: AuthUser; apiKey: string }> {
  const slug = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'
  const email = (opts.email ?? `${slug}@bots.local`).toLowerCase()
  const label = opts.keyLabel ?? `${slug}-bot`

  // Adopt ONLY accounts this function created: displayName has no uniqueness anywhere, so a human
  // who signed up (or squatted) as 'Ask AI' must never be hijacked — the unconditional
  // `bot: true` marker written at creation is the discriminator.
  const findExisting = async (): Promise<AuthUser | undefined> =>
    (await authKit.users.find({ filter: eq('displayName', opts.name), includeDeactivated: true })).find(
      (u) => u.metadata?.bot === true,
    )
  let user = await findExisting()
  if (!user) {
    try {
      user = await authKit.users.create({ email, displayName: opts.name, metadata: { ...opts.metadata, bot: true } })
    } catch (e) {
      // a concurrent provision can win the create race — resolve by name once more before giving up
      // (a genuine email clash with a DIFFERENTLY-named account stays an error: pass an explicit email)
      if ((e as { code?: string }).code !== 'CONFLICT') throw e
      user = await findExisting()
      if (!user) throw e
    }
  }
  if (user.deletedAt !== null && user.deletedAt !== undefined) {
    await authKit.users.reactivate(user.id)
    user = { ...user, deletedAt: null }
  }

  for (const k of await authKit.apiKeys.listFor(user.id)) if (k.label === label) await authKit.apiKeys.revoke(k.id)
  const { key } = await authKit.apiKeys.create(user.id, { role: opts.role ?? 'user', label })

  for (const channelId of opts.channels ?? []) {
    try {
      await chatKit.members.add(channelId, user.id)
    } catch (e) {
      if ((e as { code?: string }).code !== 'CONFLICT') throw e
    }
  }
  return { user, apiKey: key }
}
