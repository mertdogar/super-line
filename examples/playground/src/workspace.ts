import { eq } from '@super-line/core'
import type { AuthCredentialsApi, AuthUsersApi } from '@super-line/plugin-auth/server'
import type { ChatServer } from '@super-line/plugin-chat/server'

const BOT_NAME = 'Echo Bot'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The workspace both hosts share: the Node nodes (server.ts) and the Durable Object (worker.ts). Everything
 * here is idempotent — the Durable Object re-runs it on every wake.
 */
export function workspace({ users, credentials, chatKit }: { users: AuthUsersApi; credentials: AuthCredentialsApi; chatKit: ChatServer }) {
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

  /** Two channels, three demo logins (password "superline") and the bot. Two reads once seeded. */
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
