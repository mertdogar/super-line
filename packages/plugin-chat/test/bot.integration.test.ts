// The bot loop + provisioning (PLAN-chat-mastra Phase B): onChatMessage's watch/join/dedup/queue
// mechanics against a real loopback server, and provisionChatBot's restart idempotency.

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract, type ChatTurnMessage } from '@super-line/plugin-chat'
import { chat, provisionChatBot } from '@super-line/plugin-chat/server'
import type { ChatHooks } from '@super-line/plugin-chat/server'
import { chatClient, onChatMessage } from '@super-line/plugin-chat/client'
import type { ChatMessageContext } from '@super-line/plugin-chat/client'
import { createHarness, waitFor } from '../../server/test/harness.js'

const app = defineContract({
  roles: { user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } } },
  plugins: [authContract(), chatContract()],
})

const h = createHarness()
const stops: Array<() => void> = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
  return h.dispose()
})

async function boot(hooks?: ChatHooks) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app, ...(hooks ? { hooks } : {}) })
  const { srv, url } = await h.server(app, {
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin, chatKit.plugin],
  })
  srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)
  return { url, authKit, chatKit }
}

async function newUser(url: string, email: string, name: string) {
  const g = h.client(app, { url, role: 'guest' })
  const { token, userId } = await g.signUp({ email, password: 'passpass', displayName: name })
  g.close()
  const c = h.client(app, { url, role: 'user', params: { token } })
  return { c, userId }
}

async function botOn(url: string, authKit: Awaited<ReturnType<typeof boot>>['authKit'], chatKit: Awaited<ReturnType<typeof boot>>['chatKit'], channels?: string[]) {
  const { user, apiKey } = await provisionChatBot(authKit, chatKit, { name: 'Bot', ...(channels ? { channels } : {}) })
  const c = h.client(app, { url, role: 'user', params: { apiKey } })
  const bot = chatClient(c, { userId: user.id })
  await bot.ready
  return { bot, user, c }
}

describe('plugin-chat/client — onChatMessage', () => {
  it("'all' mode: joins a channel created LATER, answers new messages, skips backlog and its own", async () => {
    const { url, authKit, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const before = await annChat.createChannel({ name: 'early' })
    await annChat.send(before.id, 'backlog — must never trigger')

    const { bot } = await botOn(url, authKit, chatKit)
    const calls: ChatMessageContext<typeof app>[] = []
    stops.push(
      onChatMessage(bot, async (ctx) => {
        calls.push(ctx)
        await bot.send(ctx.channelId, `echo: ${String(ctx.message.content)}`)
      }),
    )
    // the bot joined the pre-existing channel but its backlog is context, not a trigger
    await waitFor(async () => (await chatKit.members.of(before.id)).some((m) => m.userId === bot.userId))
    expect(calls).toEqual([])

    const late = await annChat.createChannel({ name: 'late' }) // appears in the live directory
    await waitFor(async () => (await chatKit.members.of(late.id)).some((m) => m.userId === bot.userId))
    await annChat.send(late.id, 'hello bot')

    await waitFor(() => calls.length === 1)
    expect(calls[0]).toMatchObject({ channelId: late.id, message: { content: 'hello bot' } })
    const last = calls[0]!.history.at(-1)
    expect(last).toEqual({ role: 'user', content: 'hello bot' }) // trigger included, correctly attributed

    // the bot's own echo lands in the channel but never re-triggers the handler
    const feed = annChat.messages(late.id)
    await waitFor(() => feed.rows().some((m) => m.content === 'echo: hello bot'))
    expect(calls.length).toBe(1)
    annChat.close()
    ann.c.close()
  })

  it('serializes turns per channel: a message arriving mid-answer waits, and its history sees the finished answer', async () => {
    const { url, authKit, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'general' })

    const { bot } = await botOn(url, authKit, chatKit)
    let inFlight = 0
    let maxInFlight = 0
    const histories: ChatTurnMessage[][] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => (releaseFirst = r))
    stops.push(
      onChatMessage(bot, async (ctx) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        histories.push(ctx.history)
        if (histories.length === 1) {
          await firstGate // hold turn 1 open while message 2 arrives
          await bot.send(ctx.channelId, 'answer one')
        }
        inFlight--
      }),
    )
    await waitFor(async () => (await chatKit.members.of(ch.id)).some((m) => m.userId === bot.userId))

    await annChat.send(ch.id, 'first')
    await waitFor(() => histories.length === 1)
    await annChat.send(ch.id, 'second') // lands while turn 1 is parked on the gate
    await new Promise((r) => setTimeout(r, 50))
    expect(histories.length).toBe(1) // queued, not concurrent
    releaseFirst()

    await waitFor(() => histories.length === 2)
    expect(maxInFlight).toBe(1)
    // dequeue-time history: turn 2 already contains turn 1's answer (sent AFTER 'second' landed,
    // so it's chronologically last), correctly attributed
    expect(histories[1]).toContainEqual({ role: 'assistant', content: 'answer one' })
    expect(histories[1]).toContainEqual({ role: 'user', content: 'second' })
    expect(histories[0]).not.toContainEqual({ role: 'user', content: 'second' }) // turn 1 predates it
    annChat.close()
    ann.c.close()
  })

  it('defers a streaming message until it settles, and a fixed channel list ignores other channels', async () => {
    const { url, authKit, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const watchedCh = await annChat.createChannel({ name: 'watched' })
    const otherCh = await annChat.createChannel({ name: 'other' })

    const { bot } = await botOn(url, authKit, chatKit)
    const calls: ChatMessageContext<typeof app>[] = []
    stops.push(onChatMessage(bot, (ctx) => void calls.push(ctx), { channels: [watchedCh.id] }))
    await waitFor(async () => (await chatKit.members.of(watchedCh.id)).some((m) => m.userId === bot.userId))

    await annChat.send(otherCh.id, 'wrong channel') // never watched
    const w = await annChat.stream(watchedCh.id)
    w.push({ type: 'part_start', key: 't1', partType: 'text' }, { type: 'delta', key: 't1', text: 'streaming…' })
    await w.flush()
    await new Promise((r) => setTimeout(r, 80))
    expect(calls).toEqual([]) // mid-stream: not a trigger yet

    await w.finalize()
    await waitFor(() => calls.length === 1)
    expect(calls[0]!.message).toMatchObject({ channelId: watchedCh.id, status: 'complete' })
    annChat.close()
    ann.c.close()
  })

  it('a vetoed join is retried on the next directory tick instead of blinding the bot forever', async () => {
    let vetoes = 1
    const { url, authKit, chatKit } = await boot({
      joinChannel: {
        before: (input) => {
          if (vetoes > 0) {
            vetoes--
            throw new Error('not yet')
          }
          return input
        },
      },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'gated' })

    const { bot } = await botOn(url, authKit, chatKit)
    const calls: string[] = []
    stops.push(onChatMessage(bot, (ctx) => void calls.push(String(ctx.message.content))))
    await waitFor(() => vetoes === 0) // first join attempt consumed the veto

    await annChat.createChannel({ name: 'tick' }) // directory change → retry the failed join
    await waitFor(async () => (await chatKit.members.of(ch.id)).some((m) => m.userId === bot.userId))
    await annChat.send(ch.id, 'after retry')
    await waitFor(() => calls.includes('after retry'))
    annChat.close()
    ann.c.close()
  })
})

describe('plugin-chat/server — provisionChatBot', () => {
  it('is restart-idempotent: same user, same-label key re-minted (old key dead), channels joined once', async () => {
    const { url, authKit, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    await annChat.ready
    const ch = await annChat.createChannel({ name: 'general' })

    const first = await provisionChatBot(authKit, chatKit, { name: 'Super Visor', channels: [ch.id] })
    const second = await provisionChatBot(authKit, chatKit, { name: 'Super Visor', channels: [ch.id] })
    expect(second.user.id).toBe(first.user.id)

    const keys = await authKit.apiKeys.listFor(first.user.id)
    expect(keys.filter((k) => k.label === 'super-visor-bot').length).toBe(1) // re-minted, not accumulated

    const dead = h.client(app, { url, role: 'user', params: { apiKey: first.apiKey } })
    const who = await dead.whoami().catch(() => null) // revoked key: rejected OR identity-less
    expect(who?.userId ?? null).toBeNull() // either way, run 1's key no longer IS the bot
    dead.close()
    const live = h.client(app, { url, role: 'user', params: { apiKey: second.apiKey } })
    expect((await live.whoami())?.userId).toBe(first.user.id)
    live.close()

    const members = await chatKit.members.of(ch.id)
    expect(members.filter((m) => m.userId === first.user.id).length).toBe(1)
    annChat.close()
    ann.c.close()
  })

  it('reactivates a soft-deleted bot', async () => {
    const { authKit, chatKit } = await boot()
    const first = await provisionChatBot(authKit, chatKit, { name: 'Bot' })
    await authKit.users.deactivate(first.user.id)

    const again = await provisionChatBot(authKit, chatKit, { name: 'Bot' })
    expect(again.user.id).toBe(first.user.id)
    expect(again.user.deletedAt).toBeNull()
    expect((await authKit.users.get(first.user.id))?.deletedAt).toBeNull()
  })
})
