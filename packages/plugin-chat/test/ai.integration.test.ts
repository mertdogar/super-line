import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { chatAgentTools, pipeUIMessageStream } from '@super-line/plugin-chat/ai'
import type { ToolSet, UIMessageChunk } from 'ai'
import { createHarness, waitFor } from '../../server/test/harness.js'

const app = defineContract({
  roles: {
    user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract(), chatContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

// tools never see a real LLM here — execute() is called directly, against a real loopback server
const call = async (tools: ToolSet, name: string, input: unknown): Promise<any> =>
  (tools[name]!.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, { toolCallId: 't', messages: [] })

async function boot() {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app })
  const { srv, url } = await h.server(app, {
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin, chatKit.plugin],
  })
  srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)

  // a human + a provisioned agent (decision 13: passwordless user + server-minted API key)
  const g = h.client(app, { url, role: 'guest' })
  const human = await g.signUp({ email: 'ann@x.com', password: 'passpass', displayName: 'Ann' })
  g.close()
  const annClient = h.client(app, { url, role: 'user', params: { token: human.token } })

  const bot = await authKit.users.create({ email: 'bot@x.com', displayName: 'Helper Bot' })
  const key = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'agent' })
  const botClient = h.client(app, { url, role: 'user', params: { apiKey: key.key } })

  return { url, authKit, chatKit, annClient, annId: human.userId, botClient, botId: bot.id }
}

describe('plugin-chat/ai — agent toolset', () => {
  it('gates the management group behind the flag', async () => {
    const { botClient } = await boot()
    const core = chatAgentTools(botClient)
    const managed = chatAgentTools(botClient, { management: true })
    expect(Object.keys(core).sort()).toEqual(
      ['join_channel', 'leave_channel', 'list_channels', 'list_members', 'read_messages', 'send_message'].sort(),
    )
    expect(Object.keys(managed)).toEqual(expect.arrayContaining(['create_channel', 'add_member', 'list_users']))
    botClient.close()
  })

  it('list → join → read → send round-trip, with author names, ISO timestamps, and live fan-out', async () => {
    const { annClient, annId, botClient, botId } = await boot()
    const ann = chatClient(annClient, { userId: annId })
    const ch = await ann.createChannel({ name: 'general' })
    await ann.send(ch.id, 'hello agent')

    const tools = chatAgentTools(botClient)

    // the bot sees the public channel and knows it is NOT a member yet
    const channels = await call(tools, 'list_channels', {})
    expect(channels).toEqual([{ id: ch.id, name: 'general', visibility: 'public', member: false }])

    await call(tools, 'join_channel', { channelId: ch.id })
    const msgs = await call(tools, 'read_messages', { channelId: ch.id, limit: 10 })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ author: 'Ann', authorId: annId, content: 'hello agent', edited: false })
    expect(new Date(msgs[0].createdAt).getTime()).toBeGreaterThan(0) // valid ISO

    const members = await call(tools, 'list_members', { channelId: ch.id })
    expect(members).toEqual(
      expect.arrayContaining([
        { userId: annId, name: 'Ann', role: 'owner' },
        { userId: botId, name: 'Helper Bot', role: 'member' },
      ]),
    )

    // the bot's send lands on the human's LIVE feed
    const feed = ann.messages(ch.id)
    await feed.ready
    const sent = await call(tools, 'send_message', { channelId: ch.id, content: 'hi Ann!' })
    expect(sent).toMatchObject({ channelId: ch.id, id: expect.any(String) })
    await waitFor(() => feed.rows().some((m) => m.content === 'hi Ann!' && m.authorId === botId))

    await call(tools, 'leave_channel', { channelId: ch.id })
    const after = await call(tools, 'list_channels', {})
    expect(after[0].member).toBe(false)
    ann.close()
    annClient.close()
    botClient.close()
  })

  it('failures come back structured — the model reads FORBIDDEN instead of the loop aborting', async () => {
    const { annClient, annId, botClient, botId } = await boot()
    const ann = chatClient(annClient, { userId: annId })
    const secret = await ann.createChannel({ name: 'secret', visibility: 'private' })
    const tools = chatAgentTools(botClient, { management: true })

    // not a member of the private channel → sends are refused, structurally
    const denied = await call(tools, 'send_message', { channelId: secret.id, content: 'let me in' })
    expect(denied).toMatchObject({ error: expect.stringMatching(/FORBIDDEN|NOT_FOUND/), message: expect.any(String) })

    // and RLS means the private channel isn't even visible to the bot
    const channels = await call(tools, 'list_channels', {})
    expect(channels.find((c: { id: string }) => c.id === secret.id)).toBeUndefined()

    // management on a channel the bot doesn't own → FORBIDDEN, structured
    const pub = await ann.createChannel({ name: 'general' })
    await call(tools, 'join_channel', { channelId: pub.id })
    const kick = await call(tools, 'remove_member', { channelId: pub.id, userId: annId })
    expect(kick).toMatchObject({ error: 'FORBIDDEN' })
    void botId
    ann.close()
    annClient.close()
    botClient.close()
  })

  it('management happy path: the bot creates + staffs its own channel and edits its message', async () => {
    const { annId, botClient, annClient } = await boot()
    const tools = chatAgentTools(botClient, { management: true })

    const created = await call(tools, 'create_channel', { name: 'bot-ops', visibility: 'private' })
    expect(created).toMatchObject({ name: 'bot-ops', visibility: 'private' })

    const found = await call(tools, 'list_users', { query: 'ann' }) // ilike, case-insensitive
    expect(found).toEqual([{ userId: annId, name: 'Ann' }])
    await call(tools, 'add_member', { channelId: created.id, userId: annId })

    const sent = await call(tools, 'send_message', { channelId: created.id, content: 'draft' })
    const edited = await call(tools, 'edit_message', { id: sent.id, content: 'final' })
    expect(edited.editedAt).toEqual(expect.any(String))
    const msgs = await call(tools, 'read_messages', { channelId: created.id })
    expect(msgs.map((m: { content: unknown }) => m.content)).toEqual(['final'])

    await call(tools, 'delete_message', { id: sent.id })
    expect(await call(tools, 'read_messages', { channelId: created.id })).toEqual([])
    annClient.close()
    botClient.close()
  })

  it('list_users excludes deactivated users BEFORE the limit — a window of deactivated matches cannot hide active ones', async () => {
    const { authKit, botClient } = await boot()
    // two deactivated "Bob"s land first (insertion order), then the active one
    for (const n of [1, 2]) {
      const u = await authKit.users.create({ email: `bob${n}@x.com`, displayName: `Bob ${n}` })
      await authKit.users.deactivate(u.id)
    }
    const real = await authKit.users.create({ email: 'bob3@x.com', displayName: 'Bob 3' })

    const tools = chatAgentTools(botClient, { management: true })
    // with limit 2, a post-fetch filter would return [] (the window fills with deactivated Bobs);
    // the IR-level exclusion must surface the active Bob instead
    const found = await call(tools, 'list_users', { query: 'bob', limit: 2 })
    expect(found).toEqual([{ userId: real.id, name: 'Bob 3' }])
    botClient.close()
  })

  it('pipeUIMessageStream maps a full AI SDK turn — text, reasoning, tools (late start, errors) — onto one streamed message', async () => {
    const { annClient, annId, botClient } = await boot()
    const ann = chatClient(annClient, { userId: annId })
    const ch = await ann.createChannel({ name: 'general' })
    const bot = chatClient(botClient)
    await bot.ready
    await bot.join(ch.id)

    async function* turn(): AsyncGenerator<UIMessageChunk> {
      yield { type: 'start' } as UIMessageChunk // framing — dropped
      // ── step 1: text id '0' — the SDK resets ids per step, so step 2 REUSES '0'
      yield { type: 'start-step' } as UIMessageChunk
      yield { type: 'reasoning-start', id: 'r1' }
      yield { type: 'reasoning-delta', id: 'r1', delta: 'pondering' }
      yield { type: 'reasoning-end', id: 'r1' }
      yield { type: 'text-start', id: '0' }
      yield { type: 'text-delta', id: '0', delta: 'checking… ' }
      yield { type: 'text-end', id: '0' }
      yield { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'weather' }
      yield { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'weather', input: { city: 'Ankara' } }
      // a preliminary (progress) result must NOT settle the tool part
      yield { type: 'tool-output-available', toolCallId: 'call-1', output: { progress: 50 }, preliminary: true }
      yield { type: 'tool-output-available', toolCallId: 'call-1', output: { temp: 23 } }
      // a second tool whose args were never streamed — input-available arrives WITHOUT input-start
      yield { type: 'tool-input-available', toolCallId: 'call-2', toolName: 'send_report', input: { to: 'x' } }
      yield { type: 'tool-output-error', toolCallId: 'call-2', errorText: 'smtp down' }
      yield { type: 'finish-step' } as UIMessageChunk
      // ── step 2: SAME text id '0' — collided with step 1 before step-namespacing
      yield { type: 'start-step' } as UIMessageChunk
      yield { type: 'text-start', id: '0' }
      yield { type: 'text-delta', id: '0', delta: '23°C in Ankara' }
      yield { type: 'text-end', id: '0' }
      yield { type: 'error', errorText: 'post-text hiccup' }
    }

    const w = await bot.stream(ch.id)
    const { error } = await pipeUIMessageStream(w, turn())
    expect(error).toBe('post-text hiccup') // returned, not thrown — the producer decides
    const done = await w.finalize()
    expect(done.content).toBe('checking… \n\n23°C in Ankara') // both root text parts project, in order

    const feed = ann.messages(ch.id)
    await feed.ready
    await waitFor(() => (feed.rows().find((m) => m.id === w.messageId)?.parts?.length ?? 0) === 5)
    const parts = feed.rows().find((m) => m.id === w.messageId)!.parts!
    expect(parts.map((p) => [p.type, p.toolName ?? p.text])).toEqual([
      ['reasoning', 'pondering'],
      ['text', 'checking… '],
      ['tool', 'weather'],
      ['tool', 'send_report'],
      ['text', '23°C in Ankara'], // step-2 id '0' did NOT collide with step-1 id '0'
    ])
    expect(parts[2]).toMatchObject({ state: 'done', args: { city: 'Ankara' }, result: { temp: 23 } })
    expect(parts[3]).toMatchObject({ state: 'done', isError: true, result: { error: 'smtp down' } })
    ann.close()
    bot.close()
    annClient.close()
    botClient.close()
  })

  it('host-parametrized content shapes the send_message tool schema and passes validation end-to-end', async () => {
    const richContent = z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string().describe('The message text') }),
      z.object({ type: z.literal('link'), url: z.string(), title: z.string() }),
    ])
    const richApp = defineContract({
      roles: {
        user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
      },
      plugins: [authContract(), chatContract({ content: richContent })],
    })
    const backend = memoryCollections()
    const authKit = auth({ contract: richApp, collections: backend, defaultRoles: ['user'] })
    const chatKit = chat({ contract: richApp })
    const { srv, url } = await h.server(richApp, {
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin, chatKit.plugin],
    })
    srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)

    const bot = await authKit.users.create({ email: 'bot@x.com', displayName: 'Bot' })
    const key = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'agent' })
    const botClient = h.client(richApp, { url, role: 'user', params: { apiKey: key.key } })

    const tools = chatAgentTools(botClient, { content: richContent, management: true })
    const ch = await call(tools, 'create_channel', { name: 'media' })
    const ok = await call(tools, 'send_message', {
      channelId: ch.id,
      content: { type: 'link', url: 'https://x', title: 'X' },
    })
    expect(ok).toMatchObject({ id: expect.any(String) })
    // an out-of-schema body is refused by the SERVER (defense in depth beyond the tool schema)
    const bad = await call(tools, 'send_message', { channelId: ch.id, content: { type: 'video' } })
    expect(bad).toHaveProperty('error')
    botClient.close()
  })

})
