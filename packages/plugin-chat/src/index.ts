import { z } from 'zod'
import { defineContractPlugin, defineSurface } from '@super-line/core'

/** Channel visibility: `public` = discoverable + self-service join; `private` = membership-RLS'd, added by an owner. */
export const CHANNEL_VISIBILITIES = ['public', 'private'] as const
export type ChannelVisibility = (typeof CHANNEL_VISIBILITIES)[number]

/** Two tiers only: owners manage membership and the channel; members chat and can always self-leave. */
export const MEMBER_ROLES = ['owner', 'member'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** Streaming lifecycle of a message. Absent = a plain one-shot send (never streamed). */
export const MESSAGE_STATUSES = ['streaming', 'complete', 'aborted', 'error'] as const
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/** Part kinds a streamed message accumulates (PLAN-chat-streaming decision 2). */
export const PART_TYPES = ['text', 'reasoning', 'tool'] as const
export type PartType = (typeof PART_TYPES)[number]

/** A tool part's lifecycle: args streaming in → executing → settled (result/isError present). */
export const TOOL_STATES = ['input-streaming', 'running', 'done'] as const
export type ToolState = (typeof TOOL_STATES)[number]

/**
 * The host's opaque extension slot, present on all three collections (validate its shape in `before` hooks).
 * On MESSAGES one key is reserved: `metadata.resource` carries the plugin's resource cards
 * (created/attached/detached announcements, PLAN-chat-resources) — treat it like `metadata.bot` on users.
 */
const metadata = z.record(z.string(), z.unknown()).optional()

/** A resource kind's lifecycle: `owned` = chat-minted, one channel, dies with it; `linked` = host-id'd, multi-channel, never chat-deleted. */
export const RESOURCE_LIFECYCLES = ['owned', 'linked'] as const
export type ResourceLifecycle = (typeof RESOURCE_LIFECYCLES)[number]

/** The `metadata.resource` payload of a resource-card message (content stays absent — clients render from this). */
export interface ResourceCard {
  action: 'created' | 'attached' | 'detached'
  kind: string
  docId: string
  title: string
}

// ── row schemas ──────────────────────────────────────────────────────────────────────────────────

/** A channel. `createdBy: null` = created by server code; `name` is NOT unique (enforce via a `before createChannel` hook if wanted). */
export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.enum(CHANNEL_VISIBILITIES),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
  metadata,
})

/** A membership. pk = `${channelId}:${userId}` (see {@link memId}) — duplicate membership is structurally impossible. `addedBy: null` = self-join or server. */
export const membershipSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  userId: z.string(),
  role: z.enum(MEMBER_ROLES),
  addedBy: z.string().nullable(),
  createdAt: z.number(),
  metadata,
})

/**
 * The messages schema, generic over the HOST-PARAMETRIZED body (PLAN-plugin-chat decision 8):
 * `chatContract({ content })` slots the host's schema in here AND into the send/edit request inputs,
 * so the server validates every message body and types flow end-to-end. Default body: plain text.
 */
export const messageSchema = <S extends z.ZodTypeAny>(content: S) =>
  z.object({
    id: z.string(),
    channelId: z.string(),
    authorId: z.string(),
    // OPTIONAL because a STREAMED message's envelope stays quiet until finalize derives the
    // projection (PLAN-chat-streaming decision 9); plain sends always carry it
    content: content.optional(),
    createdAt: z.number(),
    editedAt: z.number().nullable(),
    // streaming lifecycle — absent on plain sends
    status: z.enum(MESSAGE_STATUSES).optional(),
    error: z.string().optional(),
    metadata,
  })

/**
 * One block of a streamed message — its own row so a rewrite is bounded by PART size, never turn
 * size (PLAN-chat-streaming decision 3). pk = `${messageId}:${idx}` (server-assigned idx).
 * `parent` = the `toolCallId` of the delegating tool part this nests under (subagent trees,
 * decision 10); null = root lane. `offset` = the checkpointed length of `text` — live deltas splice
 * on top of it. `lastActivityAt` is stamped at every checkpoint so staleness is visible.
 */
export const messagePartSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  channelId: z.string(), // denormalized: the parts RLS filter keys on it
  idx: z.number(),
  type: z.enum(PART_TYPES),
  parent: z.string().nullable(),
  text: z.string(),
  offset: z.number(),
  done: z.boolean(),
  lastActivityAt: z.number(),
  // tool parts only:
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
  state: z.enum(TOOL_STATES).optional(),
})
export type ChatMessagePart = z.infer<typeof messagePartSchema>

/** The parts pk — mirrors {@link memId}'s role for memberships. */
export const partId = (messageId: string, idx: number): string => `${messageId}:${idx}`

/**
 * The channel-resource link registry (PLAN-chat-resources): which docs belong to which channel.
 * pk = `${channelId}:${kind}:${docId}` (see {@link resourceId}) — duplicate attach is structurally
 * impossible, and a create-or-attach race lands on the same row. `collection` is denormalized from
 * the server-side kind registry at write time so rows self-describe which CRDT collection to open.
 * `title` is immutable in v1. `createdBy: null` = created by server code.
 */
export const resourceSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  kind: z.string(),
  collection: z.string(),
  docId: z.string(),
  title: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
})
export type ChatResource = z.infer<typeof resourceSchema>

/** The resources pk — mirrors {@link memId}'s role for memberships. */
export const resourceId = (channelId: string, kind: string, docId: string): string => `${channelId}:${kind}:${docId}`

/**
 * Coarse who's-open presence on a resource doc (PLAN-chat-resources). DOC-scoped, deliberately not
 * channel-scoped — a channelId field would LWW-clobber when one linked doc is open via two channels.
 * pk = `${collection}:${docId}:${userId}` (per user, not per tab). Liveness = `heartbeatAt` recency
 * (recommended: 20s heartbeats, consider rows younger than 45s live); rows age out via
 * `chatKit.resources.sweepPresence`, never a plugin timer.
 */
export const resourcePresenceSchema = z.object({
  id: z.string(),
  docKey: z.string(), // `${collection}:${docId}` — the read-filter key
  collection: z.string(),
  docId: z.string(),
  userId: z.string(),
  openedAt: z.number(),
  heartbeatAt: z.number(),
})
export type ResourcePresence = z.infer<typeof resourcePresenceSchema>

/** The presence doc key + pk helpers. */
export const docKeyOf = (collection: string, docId: string): string => `${collection}:${docId}`
export const presenceId = (collection: string, docId: string, userId: string): string =>
  `${collection}:${docId}:${userId}`

/** How fresh a presence row must be to count as live (see {@link resourcePresenceSchema}). */
export const PRESENCE_LIVE_MS = 45_000

/**
 * One path write in a `writeResource` batch: set a value at an OBJECT-KEY path, or delete the key at
 * it. Paths are string keys only — array elements cannot be addressed (the CRDT store treats arrays
 * as opaque leaves, so an index write would silently replace the array with a map; replace the whole
 * array by setting it at its object key instead). Deletes come FIRST in the union and both branches
 * are strict — a hybrid `{ path, delete, set }` or a bare `{ path }` fails loudly instead of being
 * silently reinterpreted.
 */
export const resourceWriteOpSchema = z.union([
  z.object({ path: z.array(z.string()).min(1), delete: z.literal(true) }).strict(),
  z.object({ path: z.array(z.string()).min(1), set: z.unknown() }).strict(),
])
export type ResourceWriteOp = { path: string[]; delete: true } | { path: string[]; set?: unknown }

/**
 * The append vocabulary — a PLUGIN-OWNED union, deliberately not AI SDK `UIMessageChunk`
 * (decision 4: adapters absorb SDK drift at the edge). `key` is the producer's handle for a part —
 * for tool parts it MUST be the `toolCallId`; the server maps key→idx. `delta` applies to
 * text/reasoning parts only (tool args land whole via `part_patch`).
 */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('part_start'),
    key: z.string(),
    partType: z.enum(PART_TYPES),
    toolName: z.string().optional(),
    parent: z.string().optional(),
  }),
  z.object({ type: z.literal('delta'), key: z.string(), text: z.string() }),
  z.object({
    type: z.literal('part_patch'),
    key: z.string(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
    state: z.enum(['running', 'done']).optional(),
  }),
  z.object({ type: z.literal('part_end'), key: z.string(), text: z.string().optional() }),
])
export type ChatStreamEvent = z.infer<typeof streamEventSchema>

/**
 * The writer shape the stream bridges drive (`pipeUIMessageStream`, `pipeMastraStream`,
 * `mastraEngine`) — both `chatClient`'s handle and `chatKit`'s writer fit.
 */
export interface StreamEventSink {
  push(...events: ChatStreamEvent[]): void | Promise<void>
}

/**
 * One settled chat turn folded into model input — the discriminated shape Mastra's and the AI
 * SDK's message arrays both accept. `onChatMessage` assembles these; `mastraEngine.run` consumes
 * them.
 */
export type ChatTurnMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string }

export type ChatChannel = z.infer<typeof channelSchema>
export type ChatMembership = z.infer<typeof membershipSchema>
/**
 * A message row. `Content` defaults to `unknown` — the server kit never inspects the body.
 * `content` is absent on a still-streaming envelope (the finalize projection fills it);
 * `status` is absent on plain one-shot sends.
 */
export interface ChatMessage<Content = unknown> {
  id: string
  channelId: string
  authorId: string
  content?: Content
  createdAt: number
  editedAt: number | null
  status?: MessageStatus
  error?: string
  metadata?: Record<string, unknown>
}

/** The membership primary key — shared by the server kit and (later) the client half. */
export const memId = (channelId: string, userId: string): string => `${channelId}:${userId}`

// ── request defs (built per content schema — shared by the fragment AND the server plugin surface) ─

const requestDefs = <S extends z.ZodTypeAny>(content: S) => {
  const message = messageSchema(content)
  return {
    // channel + owner membership in one server-authoritative op (a pure row-write can't: you can't
    // pass an owner-membership policy for a channel that doesn't exist yet)
    createChannel: {
      input: z.object({ name: z.string().min(1), visibility: z.enum(CHANNEL_VISIBILITIES).optional(), metadata }),
      output: channelSchema,
    },
    updateChannel: {
      input: z.object({ id: z.string(), name: z.string().min(1).optional(), metadata }),
      output: channelSchema,
    },
    deleteChannel: { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
    joinChannel: { input: z.object({ channelId: z.string() }), output: membershipSchema },
    leaveChannel: { input: z.object({ channelId: z.string() }), output: z.object({ ok: z.boolean() }) },
    addMember: {
      input: z.object({ channelId: z.string(), userId: z.string(), role: z.enum(MEMBER_ROLES).optional(), metadata }),
      output: membershipSchema,
    },
    removeMember: {
      input: z.object({ channelId: z.string(), userId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    setMemberRole: {
      input: z.object({ channelId: z.string(), userId: z.string(), role: z.enum(MEMBER_ROLES) }),
      output: membershipSchema,
    },
    sendMessage: { input: z.object({ channelId: z.string(), content, metadata }), output: message },
    editMessage: { input: z.object({ id: z.string(), content: content.optional(), metadata }), output: message },
    deleteMessage: { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
    // ── streaming (PLAN-chat-streaming decision 4): open → append batches → settle ────────────────
    startMessage: { input: z.object({ channelId: z.string(), metadata }), output: message },
    appendMessage: {
      input: z.object({ id: z.string(), events: z.array(streamEventSchema).min(1) }),
      output: z.object({ ok: z.boolean() }),
    },
    finalizeMessage: {
      input: z.object({
        id: z.string(),
        status: z.enum(['complete', 'aborted', 'error']).optional(),
        error: z.string().optional(),
      }),
      output: message,
    },
    // enter/leave the per-channel delta room — the ONLY way the plugin learns a client is viewing
    // a channel (topics can't scope per-channel; decision 5)
    watchChannel: { input: z.object({ channelId: z.string() }), output: z.object({ ok: z.boolean() }) },
    unwatchChannel: { input: z.object({ channelId: z.string() }), output: z.object({ ok: z.boolean() }) },
    // ── channel resources (PLAN-chat-resources): create-or-attach + detach; the registry is the read path ──
    createResource: {
      input: z.object({
        channelId: z.string(),
        kind: z.string(),
        title: z.string().optional(),
        // linked kinds only (owned ids are server-minted): supply to attach/create a doc under a host id
        id: z.string().optional(),
        // opaque kind-specific init input — the HOST's `init` validates it (throw VALIDATION)
        params: z.record(z.string(), z.unknown()).optional(),
      }),
      output: resourceSchema,
    },
    detachResource: {
      input: z.object({ channelId: z.string(), kind: z.string(), docId: z.string() }),
      output: resourceSchema,
    },
    // the ACKED write path (G11): DocHandle writes are void+optimistic, so a writer that needs an
    // honest synchronous answer (agents above all) routes ops through this request instead
    writeResource: {
      input: z.object({
        channelId: z.string(),
        kind: z.string(),
        docId: z.string(),
        ops: z.array(resourceWriteOpSchema).min(1).max(64),
      }),
      output: z.object({ snapshot: z.unknown() }),
    },
    // who's-open presence — deliberately hook-free (heartbeat cadence; the appendMessage precedent)
    announceResource: {
      input: z.object({ kind: z.string(), docId: z.string(), state: z.enum(['open', 'heartbeat', 'close']) }),
      output: z.object({ ok: z.boolean() }),
    },
  }
}

/**
 * Ephemeral token deltas — broadcast to the per-channel room, never persisted; the part-row
 * checkpoints are the durable floor a late joiner reconstructs from (decisions 5+6). `offset` is
 * the length of the part's text BEFORE this delta: a client applies it iff it lines up with what
 * it has, else waits for the next checkpoint row.
 */
const chatEvents = {
  'chat.streamDelta': {
    payload: z.object({
      channelId: z.string(),
      messageId: z.string(),
      partIdx: z.number(),
      offset: z.number(),
      text: z.string(),
    }),
  },
}

/**
 * The chat plugin's paired surface, typed with an opaque body (`z.unknown()`) — the server kit never
 * inspects content, so its handlers/subtraction key on this static shape while the CONTRACT carries the
 * host's real schema. `clientToServer` keys here are subtracted from the host's `implement()` obligation.
 */
export const chatSurface = defineSurface({ clientToServer: requestDefs(z.unknown()), serverToClient: chatEvents })
export type ChatSurface = typeof chatSurface

/**
 * The contract-time half of the chat plugin. Spread into
 * `defineContract({ plugins: [authContract(), chatContract()] })` — @super-line/plugin-auth is a HARD
 * prerequisite (identity, principals, and the `users` directory the FKs point at). Adds the
 * `channels`/`memberships`/`messages`/`messageParts`/`resources`/`resourcePresence` collections
 * (client-READ-ONLY: every mutation is one of the 20 `shared` requests, all hookable server-side —
 * see `chat()` in `/server`) and is generic over the message body: `chatContract({ content:
 * myBodySchema })`, default `z.string()`.
 */
export function chatContract<S extends z.ZodTypeAny = z.ZodString>(opts?: { content?: S }) {
  const content = (opts?.content ?? z.string()) as S
  return defineContractPlugin('chat', {
    collections: {
      channels: { schema: channelSchema, key: 'id' },
      memberships: {
        schema: membershipSchema,
        key: 'id',
        references: { userId: 'users', channelId: 'channels' },
      },
      messages: {
        schema: messageSchema(content),
        key: 'id',
        references: { authorId: 'users', channelId: 'channels' },
      },
      messageParts: {
        schema: messagePartSchema,
        key: 'id',
        references: { messageId: 'messages', channelId: 'channels' },
      },
      resources: {
        schema: resourceSchema,
        key: 'id',
        references: { channelId: 'channels', createdBy: 'users' },
      },
      resourcePresence: {
        schema: resourcePresenceSchema,
        key: 'id',
        references: { userId: 'users' },
      },
    },
    shared: { clientToServer: requestDefs(content), serverToClient: chatEvents },
  })
}
