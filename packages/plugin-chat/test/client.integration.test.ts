import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { createHarness, waitFor } from '../../server/test/harness.js'

const app = defineContract({
  roles: {
    user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract(), chatContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

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
  return { srv, url, authKit, chatKit }
}

async function newUser(url: string, email: string, name: string) {
  const g = h.client(app, { url, role: 'guest' })
  const { token, userId } = await g.signUp({ email, password: 'passpass', displayName: name })
  g.close()
  const c = h.client(app, { url, role: 'user', params: { token } })
  return { c, userId }
}

describe('plugin-chat/client — live stores', () => {
  it('stores deliver the snapshot and stream live changes; request wrappers round-trip', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const chat = chatClient(ann.c, { userId: ann.userId })
    await chat.ready

    const channels = chat.channels()
    await channels.ready
    expect(channels.rows()).toEqual([])

    const ch = await chat.createChannel({ name: 'general' })
    await waitFor(() => channels.rows().some((c) => c.name === 'general'))

    const feed = chat.messages(ch.id)
    const members = chat.members(ch.id)
    await Promise.all([feed.ready, members.ready])
    expect(members.rows()).toMatchObject([{ userId: ann.userId, role: 'owner' }])

    const sent = await chat.send(ch.id, 'hello world')
    expect(sent.content).toBe('hello world')
    await waitFor(() => feed.rows().length === 1)

    const edited = await chat.editMessage(sent.id, { content: 'hello, world' })
    expect(edited.editedAt).toEqual(expect.any(Number))
    await waitFor(() => feed.rows()[0]?.content === 'hello, world')

    await chat.deleteMessage(sent.id)
    await waitFor(() => feed.rows().length === 0)
    chat.close()
    ann.c.close()
  })

  it('THE MECHANIC: an open message store goes from empty to backlog when the user joins — same store object', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    const bobChat = chatClient(bob.c, { userId: bob.userId })
    await Promise.all([annChat.ready, bobChat.ready])

    const ch = await annChat.createChannel({ name: 'general' })
    await annChat.send(ch.id, 'before bob joined')

    const feed = bobChat.messages(ch.id) // opened while NOT a member
    await feed.ready
    expect(feed.rows()).toEqual([]) // RLS: nothing visible

    await bobChat.join(ch.id)
    // the store notices the membership change and re-subscribes — the backlog streams into the SAME store
    await waitFor(() => feed.rows().some((m) => m.content === 'before bob joined'))

    await bobChat.leave(ch.id)
    await waitFor(() => feed.rows().length === 0) // and drains again after leaving
    annChat.close()
    bobChat.close()
    ann.c.close()
    bob.c.close()
  })

  it('a private channel appears in an open channels() store when an owner adds the user', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const annChat = chatClient(ann.c, { userId: ann.userId })
    const bobChat = chatClient(bob.c) // userId resolved via whoami — the other construction path
    await Promise.all([annChat.ready, bobChat.ready])

    const secret = await annChat.createChannel({ name: 'secret', visibility: 'private' })
    const dir = bobChat.channels()
    await dir.ready
    expect(dir.rows()).toEqual([])

    await annChat.addMember(secret.id, bob.userId)
    await waitFor(() => dir.rows().some((c) => c.name === 'secret'))
    annChat.close()
    bobChat.close()
    ann.c.close()
    bob.c.close()
  })

  it('messages() maintains a newest-N window presented chronologically', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const chat = chatClient(ann.c, { userId: ann.userId })
    await chat.ready
    const ch = await chat.createChannel({ name: 'busy' })

    for (let i = 1; i <= 5; i++) await chat.send(ch.id, `msg ${i}`)
    const feed = chat.messages(ch.id, { limit: 3 })
    await feed.ready
    expect(feed.rows().map((m) => m.content)).toEqual(['msg 3', 'msg 4', 'msg 5']) // newest 3, oldest→newest

    await chat.send(ch.id, 'msg 6')
    await waitFor(() => feed.rows().map((m) => m.content).join() === 'msg 4,msg 5,msg 6') // window slides
    chat.close()
    ann.c.close()
  })
})
