import { eq, isIn, type Expr, type RowOf } from '@super-line/core'
import type { AuthContext } from '@super-line/plugin-auth'
import type { AuthCredentialsApi, AuthUsersApi } from '@super-line/plugin-auth/server'
import type { ChatServer } from '@super-line/plugin-chat/server'
import type { CollectionPolicy, ServerCollectionOp } from '@super-line/server'
import type { base } from './contract-base.js'

const BOT_NAME = 'Echo Bot'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Comment = RowOf<typeof base, 'comments'>

/** Matches nothing: guests see no tracker rows. */
const NONE: Expr = isIn('id', [])
// `principal` falls back to the connection id for a guest, so the guest check reads the AuthContext instead.
const signedIn = (ctx: unknown): boolean => Boolean((ctx as AuthContext | undefined)?.userId)
const readIfSignedIn = (_principal: string, ctx: unknown): Expr | undefined => (signedIn(ctx) ? undefined : NONE)

/** Row policies for the tracker collections, deny-by-default: a missing `write` refuses every write. */
export const trackerPolicies: {
  projects: CollectionPolicy<unknown, RowOf<typeof base, 'projects'>>
  tasks: CollectionPolicy<unknown, RowOf<typeof base, 'tasks'>>
  comments: CollectionPolicy<unknown, Comment>
} = {
  projects: { read: readIfSignedIn }, // seeded by the server, read-only to browsers
  tasks: { read: readIfSignedIn, write: (_principal, _op, _next, _prev, ctx) => signedIn(ctx) },
  // Author-only. Deleting someone else's comment is refused, and TanStack DB rolls the optimistic delete back.
  comments: {
    read: readIfSignedIn,
    write: (principal, op, next, prev) =>
      (op === 'insert' || prev?.authorId === principal) && (op === 'delete' || next?.authorId === principal),
  },
}

/** The server half `seed()` needs: a co-write batch and one existence check. */
interface Rows {
  batch(ops: ServerCollectionOp[]): Promise<void>
  collection(name: 'projects'): { read(id: string): Promise<unknown> }
}

/**
 * The workspace both hosts share: the Node nodes (server.ts) and the Durable Object (worker.ts). Everything
 * here is idempotent — the Durable Object re-runs it on every wake.
 */
export function workspace({
  users,
  credentials,
  chatKit,
  rows,
}: {
  users: AuthUsersApi
  credentials: AuthCredentialsApi
  chatKit: ChatServer
  rows: Rows
}) {
  let botId: string | undefined
  async function bot(): Promise<string> {
    botId ??= (await users.find({ filter: eq('displayName', BOT_NAME) }))[0]?.id
    botId ??= (await users.create({ displayName: BOT_NAME })).id
    return botId
  }

  /** Drop first-timers into every public channel so nobody lands on an empty workspace. */
  async function welcome(userId: string): Promise<void> {
    if ((await chatKit.members.channelsOf(userId)).length > 0) return
    for (const channel of await chatKit.channels.find()) {
      await chatKit.members.add(channel.id, userId).catch(() => {})
    }
  }

  /** Two channels, three demo logins (password "superline"), the bot and the tracker. Three reads once seeded. */
  async function seed(): Promise<void> {
    const channels = new Set((await chatKit.channels.find()).map((c) => c.name))
    for (const name of ['general', 'random']) if (!channels.has(name)) await chatKit.channels.create({ name })

    const known = new Set((await users.find()).map((u) => u.displayName))
    for (const name of ['Ada', 'Grace', 'Linus']) {
      if (known.has(name)) continue
      const user = await users.create({ displayName: name })
      await credentials.create(user.id, { email: `${name.toLowerCase()}@example.com`, password: 'superline' })
      await welcome(user.id)
    }
    await bot()
    await seedTracker()
  }

  /** Three projects, their tasks and a few comments, in ONE atomic batch across the three collections. */
  async function seedTracker(): Promise<void> {
    if (await rows.collection('projects').read('web')) return
    const id = new Map((await users.find()).map((u) => [u.displayName, u.id]))
    const user = (name: string) => id.get(name)!
    const now = Date.now()
    const projects = [
      ['web', 'Website', 'Ada'],
      ['mobile', 'Mobile app', 'Grace'],
      ['infra', 'Infrastructure', 'Linus'],
    ] as const
    const tasks = [
      ['t1', 'web', 'Redesign the landing page', 'doing', 2, 'Ada'],
      ['t2', 'web', 'Fix the broken signup link', 'todo', 3, 'Grace'],
      ['t3', 'web', 'Write the pricing copy', 'todo', 1, null],
      ['t4', 'mobile', 'Offline mode for the inbox', 'doing', 3, 'Grace'],
      ['t5', 'mobile', 'Dark mode', 'done', 1, 'Linus'],
      ['t6', 'mobile', 'Push notification settings', 'todo', 2, null],
      ['t7', 'infra', 'Move Postgres to logical replication', 'done', 3, 'Linus'],
      ['t8', 'infra', 'Rotate the Redis password', 'todo', 2, 'Ada'],
      ['t9', 'infra', 'Load-test the second node', 'doing', 2, 'Linus'],
    ] as const
    const comments = [
      ['t1', 'Grace', 'The hero image is in the shared drive.'],
      ['t1', 'Linus', 'Keep it under 200 KB, please.'],
      ['t4', 'Ada', 'Does this cover attachments too?'],
      ['t7', 'Grace', 'Electric picked it up without a restart.'],
      ['t9', 'Ada', 'Try 500 connections per node first.'],
    ] as const
    await rows.batch([
      ...projects.map(([pid, name, owner]) => ({ op: 'insert' as const, collection: 'projects', row: { id: pid, name, ownerId: user(owner) } })),
      ...tasks.map(([tid, projectId, title, status, priority, assignee], i) => ({
        op: 'insert' as const,
        collection: 'tasks',
        row: { id: tid, projectId, title, status, priority, assigneeId: assignee && user(assignee), createdAt: now - (tasks.length - i) * 60_000 },
      })),
      ...comments.map(([taskId, author, text], i) => ({
        op: 'insert' as const,
        collection: 'comments',
        row: { id: `c${i + 1}`, taskId, authorId: user(author), text, createdAt: now - (comments.length - i) * 30_000 },
      })),
    ])
  }

  /** The `/bot …` reply, streamed word by word into the channel. Returns the message id. */
  async function streamBotReply(channelId: string, prompt: string, node: string, signal?: AbortSignal): Promise<string> {
    const authorId = await bot()
    // every author must be a member — the server included
    if (!(await chatKit.members.get(channelId, authorId))) await chatKit.members.add(channelId, authorId)
    const writer = await chatKit.messages.stream({ channelId, authorId })
    try {
      await writer.push({ type: 'part_start', key: 'reply', partType: 'text' })
      for (const word of `${node} is streaming this word by word. You said: “${prompt || '…nothing'}”.`.split(' ')) {
        await sleep(120)
        signal?.throwIfAborted()
        await writer.push({ type: 'delta', key: 'reply', text: `${word} ` })
      }
      await writer.push({ type: 'part_end', key: 'reply' })
      await writer.finalize()
    } catch (err) {
      await writer.abort(String(err)).catch(() => {})
      throw err
    }
    return writer.messageId
  }

  return { welcome, seed, streamBotReply }
}
