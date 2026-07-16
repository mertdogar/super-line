import { tool } from 'ai'
import type { ToolSet, UIMessageChunk } from 'ai'
import { z } from 'zod'
import { and, eq, gt, ilike, isIn, not } from '@super-line/core'
import type { CollectionQuery, Contract, RoleOf } from '@super-line/core'
import type { LiveRowSet, SuperLineClient } from '@super-line/client'
import type { AuthUser } from '@super-line/plugin-auth'
import { CHANNEL_VISIBILITIES, MEMBER_ROLES } from './index.js'
import type { ChatChannel, ChatMembership, ChatMessage, ChatStreamEvent, StreamEventSink } from './index.js'

export interface ChatAgentToolsOptions<S extends z.ZodTypeAny = z.ZodString> {
  /**
   * The message-body schema, mirroring `chatContract({ content })` — it becomes `send_message`'s (and
   * `edit_message`'s) input schema, so the model fills structured bodies and the server still validates
   * them. Default: plain text. Add `.describe()`s: the model sees them.
   */
  content?: S
  /**
   * Also include the management tools (channel lifecycle, membership control, edit/delete, the user
   * directory). Default false. The server re-authorizes every call regardless — a non-owner bot calling
   * `add_member` just gets a structured FORBIDDEN back.
   */
  management?: boolean
}

/** The wire surface the tools use — the same shape `chatClient` casts to (requests live on `shared`). */
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

/** Tool results never throw — FORBIDDEN/CONFLICT/NOT_FOUND come back structured so the model can adapt. */
const asError = (e: unknown): { error: string; message: string } => {
  const s = e as { code?: string; message?: string } | undefined
  return { error: s?.code ?? 'ERROR', message: s?.message ?? String(e) }
}

const iso = (ms: number): string => new Date(ms).toISOString()

/**
 * AI SDK tools over the agent's OWN chat connection (PLAN-plugin-chat decision 17). Client-side by
 * design: every call rides the bot user's connection, so the server authorization-checks it — RLS scopes
 * reads to the bot's channels, sends require membership, management needs ownership. The model cannot
 * exceed the bot's permissions, tool or no tool.
 *
 * Stateless: reads are one-shot subscribe→rows→close (milliseconds against an LLM step), writes are the
 * plugin's typed requests. The returned record spreads straight into `ToolLoopAgent({ tools })` /
 * `generateText({ tools })`; no lifecycle, nothing to close.
 *
 * ```ts
 * const agent = new ToolLoopAgent({ model, tools: chatAgentTools(client) })
 * ```
 */
export function chatAgentTools<C extends Contract, R extends RoleOf<C>, S extends z.ZodTypeAny = z.ZodString>(
  client: SuperLineClient<C, R>,
  opts?: ChatAgentToolsOptions<S>,
): ToolSet {
  const dyn = client as unknown as Dyn
  const content = (opts?.content ?? z.string().describe('The message text')) as z.ZodTypeAny

  // one-shot read: fresh subscription → snapshot → close (server re-evaluates RLS on every subscribe,
  // so a read after joining a channel sees its backlog without any store lifecycle)
  const oneShot = async <Row>(name: string, query: CollectionQuery): Promise<Row[]> => {
    const sub = dyn.collection(name).subscribe(query)
    try {
      await sub.ready
      return sub.rows() as Row[]
    } finally {
      sub.close()
    }
  }

  let me: Promise<string | null> | undefined
  const myUserId = (): Promise<string | null> => (me ??= dyn.whoami().then((r) => r?.userId ?? null))

  const namesOf = async (userIds: string[]): Promise<Map<string, string>> => {
    if (userIds.length === 0) return new Map()
    const users = await oneShot<AuthUser>('users', { filter: isIn('id', [...new Set(userIds)]) })
    return new Map(users.map((u) => [u.id, u.displayName]))
  }

  const core: ToolSet = {
    list_channels: tool({
      description:
        'List every chat channel you can see (public channels plus private ones you belong to), with whether you are a member. You can only read or post in channels where member is true.',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const uid = await myUserId()
          const [channels, mine] = await Promise.all([
            oneShot<ChatChannel>('channels', {}),
            uid ? oneShot<ChatMembership>('memberships', { filter: eq('userId', uid) }) : Promise.resolve([]),
          ])
          const memberOf = new Set(mine.map((m) => m.channelId))
          return channels.map((c) => ({
            id: c.id,
            name: c.name,
            visibility: c.visibility,
            member: memberOf.has(c.id),
          }))
        } catch (e) {
          return asError(e)
        }
      },
    }),

    list_members: tool({
      description: 'List the members of a channel, with their display names and roles (owner or member).',
      inputSchema: z.object({ channelId: z.string().describe('The channel id (from list_channels)') }),
      execute: async ({ channelId }) => {
        try {
          const members = await oneShot<ChatMembership>('memberships', { filter: eq('channelId', channelId) })
          const names = await namesOf(members.map((m) => m.userId))
          return members.map((m) => ({
            userId: m.userId,
            name: names.get(m.userId) ?? 'unknown',
            role: m.role,
          }))
        } catch (e) {
          return asError(e)
        }
      },
    }),

    read_messages: tool({
      description:
        'Read the most recent messages of a channel you are a member of, oldest first. Returns each message with its author display name and ISO timestamp.',
      inputSchema: z.object({
        channelId: z.string().describe('The channel id (from list_channels)'),
        limit: z.number().int().positive().max(200).optional().describe('How many recent messages (default 30)'),
      }),
      execute: async ({ channelId, limit }) => {
        try {
          const window = await oneShot<ChatMessage>('messages', {
            filter: eq('channelId', channelId),
            orderBy: [
              { field: 'createdAt', dir: 'desc' },
              { field: 'id', dir: 'desc' },
            ],
            limit: limit ?? 30,
          })
          const chronological = [...window].reverse()
          const names = await namesOf(chronological.map((m) => m.authorId))
          return chronological.map((m) => ({
            id: m.id,
            author: names.get(m.authorId) ?? 'unknown',
            authorId: m.authorId,
            content: m.content,
            createdAt: iso(m.createdAt),
            edited: m.editedAt !== null,
            // streamed messages: absent content is 'still streaming' or 'no text projection', not
            // an empty send — the status disambiguates for the model
            ...(m.status !== undefined ? { status: m.status } : {}),
            ...(m.error !== undefined ? { error: m.error } : {}),
          }))
        } catch (e) {
          return asError(e)
        }
      },
    }),

    send_message: tool({
      description: 'Send a message to a channel you are a member of. Posts under your own identity.',
      inputSchema: z.object({
        channelId: z.string().describe('The channel id (from list_channels)'),
        content,
      }),
      execute: async ({ channelId, content: body }) => {
        try {
          const m = (await dyn.sendMessage({ channelId, content: body })) as ChatMessage
          return { id: m.id, channelId: m.channelId, createdAt: iso(m.createdAt) }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    join_channel: tool({
      description: 'Join a public channel (self-service). Private channels require an owner to add you.',
      inputSchema: z.object({ channelId: z.string().describe('The channel id (from list_channels)') }),
      execute: async ({ channelId }) => {
        try {
          const m = (await dyn.joinChannel({ channelId })) as ChatMembership
          return { channelId: m.channelId, role: m.role }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    leave_channel: tool({
      description: 'Leave a channel you are a member of.',
      inputSchema: z.object({ channelId: z.string().describe('The channel id (from list_channels)') }),
      execute: async ({ channelId }) => {
        try {
          await dyn.leaveChannel({ channelId })
          return { ok: true }
        } catch (e) {
          return asError(e)
        }
      },
    }),
  }

  if (!opts?.management) return core

  const management: ToolSet = {
    create_channel: tool({
      description: 'Create a channel. You become its owner and first member.',
      inputSchema: z.object({
        name: z.string().min(1).describe('The channel name'),
        visibility: z.enum(CHANNEL_VISIBILITIES).optional().describe('public (default) or private'),
      }),
      execute: async (input) => {
        try {
          const c = (await dyn.createChannel(input)) as ChatChannel
          return { id: c.id, name: c.name, visibility: c.visibility }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    update_channel: tool({
      description: 'Rename a channel. Owner-only.',
      inputSchema: z.object({
        id: z.string().describe('The channel id'),
        name: z.string().min(1).describe('The new name'),
      }),
      execute: async (input) => {
        try {
          const c = (await dyn.updateChannel(input)) as ChatChannel
          return { id: c.id, name: c.name }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    delete_channel: tool({
      description: 'Delete a channel and all its messages and memberships. Owner-only. Irreversible.',
      inputSchema: z.object({ id: z.string().describe('The channel id') }),
      execute: async ({ id }) => {
        try {
          await dyn.deleteChannel({ id })
          return { ok: true }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    add_member: tool({
      description: 'Add a user to a channel you own (find users with list_users).',
      inputSchema: z.object({
        channelId: z.string().describe('The channel id'),
        userId: z.string().describe('The user to add (from list_users or list_members)'),
        role: z.enum(MEMBER_ROLES).optional().describe('member (default) or owner'),
      }),
      execute: async (input) => {
        try {
          const m = (await dyn.addMember(input)) as ChatMembership
          return { channelId: m.channelId, userId: m.userId, role: m.role }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    remove_member: tool({
      description: 'Remove a user from a channel you own.',
      inputSchema: z.object({
        channelId: z.string().describe('The channel id'),
        userId: z.string().describe('The user to remove'),
      }),
      execute: async (input) => {
        try {
          await dyn.removeMember(input)
          return { ok: true }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    set_member_role: tool({
      description: "Change a member's role in a channel you own (promote to owner / demote to member).",
      inputSchema: z.object({
        channelId: z.string().describe('The channel id'),
        userId: z.string().describe('The member to change'),
        role: z.enum(MEMBER_ROLES).describe('The new role'),
      }),
      execute: async (input) => {
        try {
          const m = (await dyn.setMemberRole(input)) as ChatMembership
          return { channelId: m.channelId, userId: m.userId, role: m.role }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    edit_message: tool({
      description: 'Edit a message YOU sent earlier (id from read_messages).',
      // `content` is REQUIRED here though the wire allows omitting it: this tool exposes nothing else
      // to edit (no metadata), so a content-less call would be a meaningless editedAt-only stamp
      inputSchema: z.object({ id: z.string().describe('The message id'), content }),
      execute: async ({ id, content: body }) => {
        try {
          const m = (await dyn.editMessage({ id, content: body })) as ChatMessage
          return { id: m.id, editedAt: m.editedAt === null ? null : iso(m.editedAt) }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    delete_message: tool({
      description: 'Delete a message YOU sent earlier (id from read_messages). Irreversible.',
      inputSchema: z.object({ id: z.string().describe('The message id') }),
      execute: async ({ id }) => {
        try {
          await dyn.deleteMessage({ id })
          return { ok: true }
        } catch (e) {
          return asError(e)
        }
      },
    }),

    list_users: tool({
      description: 'Search the workspace user directory by display name (for add_member).',
      inputSchema: z.object({
        query: z.string().optional().describe('Substring of the display name (case-insensitive); omit for everyone'),
        limit: z.number().int().positive().max(50).optional().describe('Max results (default 20)'),
      }),
      execute: async ({ query, limit }) => {
        try {
          // deactivated users are excluded IN the IR, before the server applies `limit` — a post-fetch
          // filter would shrink an already-truncated window and silently drop active matches (this is
          // plugin-auth's own activeOnly pattern: a missing/null deletedAt fails every range op)
          const active = not(gt('deletedAt', 0))
          const users = await oneShot<AuthUser>('users', {
            filter: query ? and(ilike('displayName', `%${query}%`), active) : active,
            limit: limit ?? 20,
          })
          return users.map((u) => ({ userId: u.id, name: u.displayName }))
        } catch (e) {
          return asError(e)
        }
      },
    }),
  }

  return { ...core, ...management }
}

export type { StreamEventSink } from './index.js'

/**
 * Pipe an AI SDK v6 `UIMessageChunk` stream (`streamText(...).toUIMessageStream()`,
 * `agent.stream(...).then(r => r.toUIMessageStream())`) into a plugin-chat stream writer — the
 * one-line bridge between an AI SDK producer and a streamed chat message.
 *
 * Mapping: text/reasoning lifecycles → text/reasoning parts (writer keys namespaced `t:`/`r:` so
 * they can never collide with toolCallIds); tool chunks → ONE tool part per `toolCallId`
 * (input-available → args, output-available → result, output-error/denied → structured `isError`
 * result). `tool-input-delta`, step/message framing, `file`/`source-*`/data chunks are dropped —
 * outside the part vocabulary (PLAN-chat-streaming decision 2).
 *
 * It never settles the message: the producer owns `finalize`/`abort` (put them in a `finally`).
 * A turn-level `error` chunk is returned, not thrown — pass it to `finalize({ status: 'error' })`.
 */
export async function pipeUIMessageStream(
  writer: StreamEventSink,
  stream: AsyncIterable<UIMessageChunk> | ReadableStream<UIMessageChunk>,
): Promise<{ error?: string }> {
  const startedTools = new Set<string>()
  let error: string | undefined
  // text/reasoning chunk ids are only unique WITHIN one generation step — the SDK's own reducer
  // resets its id maps on every step boundary, so a 2-step tool-then-text turn reuses id '0'.
  // Namespace writer keys by a step counter or the second step's part_start CONFLICTs server-side.
  let step = 0

  const map = (chunk: UIMessageChunk): ChatStreamEvent[] => {
    switch (chunk.type) {
      case 'start-step':
        step++
        return []
      case 'text-start':
        return [{ type: 'part_start', key: `t:${step}:${chunk.id}`, partType: 'text' }]
      case 'text-delta':
        return chunk.delta.length > 0 ? [{ type: 'delta', key: `t:${step}:${chunk.id}`, text: chunk.delta }] : []
      case 'text-end':
        return [{ type: 'part_end', key: `t:${step}:${chunk.id}` }]
      case 'reasoning-start':
        return [{ type: 'part_start', key: `r:${step}:${chunk.id}`, partType: 'reasoning' }]
      case 'reasoning-delta':
        return chunk.delta.length > 0 ? [{ type: 'delta', key: `r:${step}:${chunk.id}`, text: chunk.delta }] : []
      case 'reasoning-end':
        return [{ type: 'part_end', key: `r:${step}:${chunk.id}` }]
      case 'tool-input-start':
        startedTools.add(chunk.toolCallId)
        return [{ type: 'part_start', key: chunk.toolCallId, partType: 'tool', toolName: chunk.toolName }]
      case 'tool-input-available': {
        // input-available may arrive without a preceding input-start (non-streamed args)
        const start: ChatStreamEvent[] = startedTools.has(chunk.toolCallId)
          ? []
          : [{ type: 'part_start', key: chunk.toolCallId, partType: 'tool', toolName: chunk.toolName }]
        startedTools.add(chunk.toolCallId)
        return [...start, { type: 'part_patch', key: chunk.toolCallId, args: chunk.input }]
      }
      case 'tool-input-error': {
        const start: ChatStreamEvent[] = startedTools.has(chunk.toolCallId)
          ? []
          : [{ type: 'part_start', key: chunk.toolCallId, partType: 'tool', toolName: chunk.toolName }]
        startedTools.add(chunk.toolCallId)
        return [
          ...start,
          {
            type: 'part_patch',
            key: chunk.toolCallId,
            args: chunk.input,
            result: { error: chunk.errorText },
            isError: true,
            state: 'done',
          },
        ]
      }
      case 'tool-output-available':
        // preliminary results stream WHILE the tool still runs — pinning state keeps the server's
        // monotonic guard from flipping the part to a terminal 'done' on the first progress update
        return [
          chunk.preliminary === true
            ? { type: 'part_patch', key: chunk.toolCallId, result: chunk.output, state: 'running' }
            : { type: 'part_patch', key: chunk.toolCallId, result: chunk.output },
        ]
      case 'tool-output-error':
        return [
          { type: 'part_patch', key: chunk.toolCallId, result: { error: chunk.errorText }, isError: true, state: 'done' },
        ]
      case 'tool-output-denied':
        return [{ type: 'part_patch', key: chunk.toolCallId, result: { denied: true }, isError: true, state: 'done' }]
      case 'error':
        error = chunk.errorText
        return []
      default:
        return [] // step/message framing, files, sources, data parts — outside the part vocabulary
    }
  }

  const iterable: AsyncIterable<UIMessageChunk> =
    Symbol.asyncIterator in stream ? (stream as AsyncIterable<UIMessageChunk>) : readAll(stream as ReadableStream<UIMessageChunk>)
  for await (const chunk of iterable) {
    const events = map(chunk)
    if (events.length > 0) await writer.push(...events)
  }
  return error !== undefined ? { error } : {}
}

async function* readAll<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
