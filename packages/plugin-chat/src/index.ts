import { z } from 'zod'
import { defineContractPlugin, defineSurface } from '@super-line/core'

/** Channel visibility: `public` = discoverable + self-service join; `private` = membership-RLS'd, added by an owner. */
export const CHANNEL_VISIBILITIES = ['public', 'private'] as const
export type ChannelVisibility = (typeof CHANNEL_VISIBILITIES)[number]

/** Two tiers only: owners manage membership and the channel; members chat and can always self-leave. */
export const MEMBER_ROLES = ['owner', 'member'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** The host's opaque extension slot, present on all three collections (validate its shape in `before` hooks). */
const metadata = z.record(z.string(), z.unknown()).optional()

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
    content,
    createdAt: z.number(),
    editedAt: z.number().nullable(),
    metadata,
  })

export type ChatChannel = z.infer<typeof channelSchema>
export type ChatMembership = z.infer<typeof membershipSchema>
/** A message row. `Content` defaults to `unknown` — the server kit never inspects the body. */
export interface ChatMessage<Content = unknown> {
  id: string
  channelId: string
  authorId: string
  content: Content
  createdAt: number
  editedAt: number | null
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
  }
}

/**
 * The chat plugin's paired surface, typed with an opaque body (`z.unknown()`) — the server kit never
 * inspects content, so its handlers/subtraction key on this static shape while the CONTRACT carries the
 * host's real schema. `clientToServer` keys here are subtracted from the host's `implement()` obligation.
 */
export const chatSurface = defineSurface({ clientToServer: requestDefs(z.unknown()) })
export type ChatSurface = typeof chatSurface

/**
 * The contract-time half of the chat plugin. Spread into
 * `defineContract({ plugins: [authContract(), chatContract()] })` — @super-line/plugin-auth is a HARD
 * prerequisite (identity, principals, and the `users` directory the FKs point at). Adds the
 * `channels`/`memberships`/`messages` collections (client-READ-ONLY: every mutation is one of the 11
 * `shared` requests, all hookable server-side — see `chat()` in `/server`) and is generic over the
 * message body: `chatContract({ content: myBodySchema })`, default `z.string()`.
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
    },
    shared: { clientToServer: requestDefs(content) },
  })
}
