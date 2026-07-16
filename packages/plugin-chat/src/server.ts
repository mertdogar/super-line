import { randomUUID } from 'node:crypto'
import { eq, isIn, or, SuperLineError } from '@super-line/core'
import type { Contract, Expr, OrderBy } from '@super-line/core'
import type { PluginContext, SuperLinePlugin } from '@super-line/server'
import type { AuthContext } from '@super-line/plugin-auth'
import { memId } from './index.js'
import type { ChatChannel, ChatMembership, ChatMessage, ChatSurface, ChannelVisibility, MemberRole } from './index.js'

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
}

export interface ChatServerOptions<C extends Contract> {
  /** The app contract — must carry BOTH fragments (`plugins: [authContract(), chatContract()]`); throws at startup otherwise. */
  contract: C
  /** Before/after extensions around every domain operation. */
  hooks?: ChatHooks
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
}

export interface ChatServer {
  /** Register in the server's `plugins: [...]` — the 11 request handlers + read-RLS/write-deny row policies. */
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
  for (const need of ['users', 'channels', 'memberships', 'messages'] as const) {
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
  const col = (n: 'channels' | 'memberships' | 'messages' | 'users') => requireCtx().collection(n)

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
    await col('messages').delete(message.id) // hard delete (decision 7) — archive in a before hook if needed
    await hooks.deleteMessage?.after?.(message, initiator)
    return message
  }

  // ── the plugin: policies (read-RLS, write-deny) + the 11 request handlers ─────────────────────────

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
    setup: (ctx) => void (pluginCtx = ctx),
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
  }

  return { plugin, channels, members, messages }
}
