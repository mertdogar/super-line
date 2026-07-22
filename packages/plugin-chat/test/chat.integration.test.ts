import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, eq, SuperLineError } from '@super-line/core'
import type { RowOf } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chat } from '@super-line/plugin-chat/server'
import type { ChatHooks } from '@super-line/plugin-chat/server'
import { createHarness, waitFor } from '../../server/test/harness.js'

// A host app with ONE request of its own — everything else arrives via the two plugins.
const app = defineContract({
  roles: {
    user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract(), chatContract()],
})

// ── compile-time proof (never invoked): subtraction + row typing flow from the merged contract ────
function _chatTypeCheck(): void {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend })
  const chatKit = chat({ contract: app })
  const srv = createSuperLineServer(app, {
    nodeKey: 'chat-typecheck',
    transports: [],
    collections: backend,
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    plugins: [authKit.plugin, chatKit.plugin],
  })
  // the host implements ONLY its own requests — all 11 chat + 10 auth handlers are subtracted
  srv.implement({ user: { hello: async () => ({ ok: true }) } })
  srv.implement({
    user: {
      hello: async () => ({ ok: true }),
      // @ts-expect-error sendMessage is plugin-handled → subtracted from implement()'s obligation
      sendMessage: async () => ({}) as never,
    },
  })
  // plugin rows infer from the single materialized contract
  const _channel: RowOf<typeof app, 'channels'>['visibility'] = 'public'
  const _content: RowOf<typeof app, 'messages'>['content'] = 'plain text by default'
  void _channel
  void _content
}
void _chatTypeCheck

const h = createHarness()
afterEach(() => h.dispose())

async function boot(hooks?: ChatHooks) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app, ...(hooks ? { hooks } : {}) })
  const { srv, url } = await h.server(app, {
    nodeKey: 'chat-test',
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

describe('plugin-chat — channels', () => {
  it('a client creates a public channel and becomes its owner; the directory serves it live', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')

    const channel = await ann.c.createChannel({ name: 'general' })
    expect(channel).toMatchObject({ name: 'general', visibility: 'public', createdBy: ann.userId })

    const dir = ann.c.collection('channels').subscribe({})
    await dir.ready
    expect(dir.rows().map((r) => r.name)).toEqual(['general'])

    const members = ann.c.collection('memberships').subscribe({})
    await members.ready
    expect(members.rows()).toMatchObject([{ channelId: channel.id, userId: ann.userId, role: 'owner', addedBy: null }])
    ann.c.close()
  })

  it('private channels are invisible to non-members (rows AND join probing)', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const secret = await ann.c.createChannel({ name: 'secret', visibility: 'private' })

    const bobDir = bob.c.collection('channels').subscribe({})
    await bobDir.ready
    expect(bobDir.rows()).toEqual([]) // not in bob's directory
    await expect(bob.c.joinChannel({ channelId: secret.id })).rejects.toMatchObject({ code: 'NOT_FOUND' }) // no existence leak

    await ann.c.addMember({ channelId: secret.id, userId: bob.userId })
    const bobDir2 = bob.c.collection('channels').subscribe({}) // fresh sub → policy re-evaluated
    await bobDir2.ready
    expect(bobDir2.rows().map((r) => r.name)).toEqual(['secret'])
    ann.c.close()
    bob.c.close()
  })

  it('updateChannel and deleteChannel are owner-only; delete cascades memberships + messages', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'temp' })
    await bob.c.joinChannel({ channelId: ch.id })
    await ann.c.sendMessage({ channelId: ch.id, content: 'to be purged' })

    await expect(bob.c.updateChannel({ id: ch.id, name: 'hijack' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const renamed = await ann.c.updateChannel({ id: ch.id, name: 'renamed', metadata: { topic: 'x' } })
    expect(renamed).toMatchObject({ name: 'renamed', metadata: { topic: 'x' } })

    await expect(bob.c.deleteChannel({ id: ch.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await ann.c.deleteChannel({ id: ch.id })
    expect(await chatKit.channels.get(ch.id)).toBeUndefined()
    expect(await chatKit.members.of(ch.id)).toEqual([])
    expect(await chatKit.messages.find({ filter: eq('channelId', ch.id) })).toEqual([])
    ann.c.close()
    bob.c.close()
  })
})

describe('plugin-chat — membership control', () => {
  it('public channels are self-service join/leave; duplicates conflict', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'general' })

    const m = await bob.c.joinChannel({ channelId: ch.id })
    expect(m).toMatchObject({ userId: bob.userId, role: 'member', addedBy: null })
    await expect(bob.c.joinChannel({ channelId: ch.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    await bob.c.leaveChannel({ channelId: ch.id })
    await expect(bob.c.leaveChannel({ channelId: ch.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    ann.c.close()
    bob.c.close()
  })

  it('addMember/removeMember/setMemberRole are owner-only; addedBy records the inviter', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const cy = await newUser(url, 'cy@x.com', 'Cy')
    const ch = await ann.c.createChannel({ name: 'team', visibility: 'private' })
    await ann.c.addMember({ channelId: ch.id, userId: bob.userId })

    // bob is a plain member — no management rights
    await expect(bob.c.addMember({ channelId: ch.id, userId: cy.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(bob.c.removeMember({ channelId: ch.id, userId: ann.userId })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      bob.c.setMemberRole({ channelId: ch.id, userId: bob.userId, role: 'owner' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const added = await ann.c.addMember({ channelId: ch.id, userId: cy.userId })
    expect(added.addedBy).toBe(ann.userId)
    await expect(ann.c.addMember({ channelId: ch.id, userId: 'ghost' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await ann.c.removeMember({ channelId: ch.id, userId: cy.userId })
    ann.c.close()
    bob.c.close()
    cy.c.close()
  })

  it('the last owner cannot leave, be removed, or demote themselves while members remain', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'team' })
    await bob.c.joinChannel({ channelId: ch.id })

    await expect(ann.c.leaveChannel({ channelId: ch.id })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      ann.c.setMemberRole({ channelId: ch.id, userId: ann.userId, role: 'member' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // the guard binds the SERVER too — the kit promotes first instead
    await expect(chatKit.members.remove(ch.id, ann.userId)).rejects.toMatchObject({ code: 'CONFLICT' })

    await ann.c.setMemberRole({ channelId: ch.id, userId: bob.userId, role: 'owner' })
    await ann.c.leaveChannel({ channelId: ch.id }) // now allowed — bob owns it
    expect((await chatKit.members.of(ch.id)).map((m) => m.role)).toEqual(['owner'])

    // a sole member (owner of an otherwise-empty channel) may always leave
    await bob.c.leaveChannel({ channelId: ch.id })
    expect(await chatKit.members.of(ch.id)).toEqual([])
    ann.c.close()
    bob.c.close()
  })
})

describe('plugin-chat — messages', () => {
  it('sending requires membership; guests are refused; reads are membership-scoped with backlog on join', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'general' })
    await ann.c.sendMessage({ channelId: ch.id, content: 'first!' })

    await expect(bob.c.sendMessage({ channelId: ch.id, content: 'intruder' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const guest = h.client(app, { url, role: 'guest' })
    await expect(guest.sendMessage({ channelId: ch.id, content: 'anon' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    guest.close()

    const before = bob.c.collection('messages').subscribe({})
    await before.ready
    expect(before.rows()).toEqual([]) // non-member: RLS filters everything

    await bob.c.joinChannel({ channelId: ch.id })
    const after = bob.c.collection('messages').subscribe({}) // fresh sub → backlog streams in
    await after.ready
    expect(after.rows().map((r) => r.content)).toEqual(['first!'])
    ann.c.close()
    bob.c.close()
  })

  it('edit stamps editedAt and is author-only (even other members are refused); delete removes the row', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'general' })
    await bob.c.joinChannel({ channelId: ch.id })
    const msg = await ann.c.sendMessage({ channelId: ch.id, content: 'typo' })
    expect(msg.editedAt).toBeNull()

    await expect(bob.c.editMessage({ id: msg.id, content: 'hijack' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(bob.c.deleteMessage({ id: msg.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const edited = await ann.c.editMessage({ id: msg.id, content: 'fixed' })
    expect(edited.content).toBe('fixed')
    expect(edited.editedAt).toEqual(expect.any(Number))

    await ann.c.deleteMessage({ id: msg.id })
    expect(await chatKit.messages.find({ filter: eq('channelId', ch.id) })).toEqual([])
    ann.c.close()
    bob.c.close()
  })
})

describe('plugin-chat — hooks (domain layer)', () => {
  it('before can veto and transform; after observes BOTH client requests and imperative kit calls', async () => {
    const events: { op: string; kind: string }[] = []
    const { url, chatKit } = await boot({
      sendMessage: {
        before: (input) => {
          if (typeof input.content === 'string' && input.content.includes('spam'))
            throw new SuperLineError('FORBIDDEN', 'no spam')
          return { ...input, content: String(input.content).toUpperCase() }
        },
        after: (_row, initiator) => void events.push({ op: 'sendMessage', kind: initiator.kind }),
      },
      createChannel: {
        after: (_c, initiator) => void events.push({ op: 'createChannel', kind: initiator.kind }),
      },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    expect(events).toContainEqual({ op: 'createChannel', kind: 'client' })

    await expect(ann.c.sendMessage({ channelId: ch.id, content: 'buy spam now' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const sent = await ann.c.sendMessage({ channelId: ch.id, content: 'hello' })
    expect(sent.content).toBe('HELLO') // transformed by before
    expect(events).toContainEqual({ op: 'sendMessage', kind: 'client' })

    // the SAME hooks fire for the imperative kit — with initiator 'server'
    const kitMsg = await chatKit.messages.send({ channelId: ch.id, authorId: ann.userId, content: 'from code' })
    expect(kitMsg.content).toBe('FROM CODE')
    expect(events).toContainEqual({ op: 'sendMessage', kind: 'server' })
    ann.c.close()
  })

  it('an after-hook error propagates to the caller but the committed write stays', async () => {
    const { url, chatKit } = await boot({
      deleteMessage: {
        after: () => {
          throw new Error('audit sink is down')
        },
      },
    })
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' })
    const msg = await ann.c.sendMessage({ channelId: ch.id, content: 'doomed' })

    await expect(ann.c.deleteMessage({ id: msg.id })).rejects.toThrow() // the error reaches the caller…
    expect(await chatKit.messages.find({ filter: eq('channelId', ch.id) })).toEqual([]) // …but the delete stays
    ann.c.close()
  })
})

describe('plugin-chat — imperative kit + agents', () => {
  it('the kit provisions channels/members server-side; hooks see initiator server; reads round-trip', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')

    const ops = await chatKit.channels.create({ name: 'ops', visibility: 'private', owner: ann.userId })
    expect(ops.createdBy).toBeNull() // server-created
    expect(await chatKit.members.of(ops.id)).toMatchObject([{ userId: ann.userId, role: 'owner', addedBy: null }])
    expect((await chatKit.members.channelsOf(ann.userId)).map((m) => m.channelId)).toEqual([ops.id])
    expect((await chatKit.channels.find({ filter: eq('visibility', 'private') })).map((c) => c.id)).toEqual([ops.id])

    // server sends also require membership — the author must really be in the channel
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    await expect(
      chatKit.messages.send({ channelId: ops.id, authorId: bob.userId, content: 'not a member' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    ann.c.close()
    bob.c.close()
  })

  it('END-TO-END agent flow: passwordless user + server-minted key + membership → the bot chats live', async () => {
    const { url, authKit, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'ask-ai' })

    // provision the agent exactly as PLAN decision 13 prescribes
    const bot = await authKit.users.create({ displayName: 'Helper Bot' })
    const key = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'helper' })
    await chatKit.members.add(ch.id, bot.id)

    // ann listens live; the bot connects with ONLY its API key and answers over the same contract
    const feed = ann.c.collection('messages').subscribe({ filter: eq('channelId', ch.id) })
    await feed.ready
    const botClient = h.client(app, { url, role: 'user', params: { apiKey: key.key } })
    await botClient.sendMessage({ channelId: ch.id, content: 'agent online' })
    await waitFor(() => feed.rows().some((m) => m.content === 'agent online'))
    expect(feed.rows().find((m) => m.content === 'agent online')?.authorId).toBe(bot.id)
    botClient.close()
    ann.c.close()
  })
})

describe('plugin-chat — host-parametrized content', () => {
  const richContent = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('image'), url: z.string(), alt: z.string() }),
  ])
  const richApp = defineContract({
    roles: {
      user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
    },
    plugins: [authContract(), chatContract({ content: richContent })],
  })

  it('the host schema validates every body — wire AND imperative — and types flow end-to-end', async () => {
    const backend = memoryCollections()
    const authKit = auth({ contract: richApp, collections: backend, defaultRoles: ['user'] })
    const chatKit = chat({ contract: richApp })
    const { srv, url } = await h.server(richApp, {
      nodeKey: 'chat-rich-test',
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin, chatKit.plugin],
    })
    srv.implement({ user: { hello: async () => ({ ok: true }) } } as never)

    const g = h.client(richApp, { url, role: 'guest' })
    const { token, userId } = await g.signUp({ email: 'r@x.com', password: 'passpass', displayName: 'R' })
    g.close()
    const c = h.client(richApp, { url, role: 'user', params: { token } })
    const ch = await c.createChannel({ name: 'media' })

    // compile-time: content is the union, not string/unknown
    const sent = await c.sendMessage({ channelId: ch.id, content: { type: 'image', url: 'https://x/i.png', alt: 'i' } })
    expect(sent.content).toEqual({ type: 'image', url: 'https://x/i.png', alt: 'i' })

    // an invalid body is rejected at the wire — nothing lands
    await expect(
      c.sendMessage({ channelId: ch.id, content: { type: 'video' } as never }),
    ).rejects.toThrow()
    // …and the schema-validated co-writer rejects the imperative path identically
    await expect(
      chatKit.messages.send({ channelId: ch.id, authorId: userId, content: { type: 'video' } }),
    ).rejects.toThrow()
    expect(await chatKit.messages.find({ filter: eq('channelId', ch.id) })).toHaveLength(1)
    c.close()
  })
})

describe('plugin-chat — review hardening', () => {
  it('guests read NOTHING — not even the public channel directory', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const ch = await ann.c.createChannel({ name: 'general' }) // a public channel exists
    await ann.c.sendMessage({ channelId: ch.id, content: 'hi' })

    const guest = h.client(app, { url, role: 'guest' })
    for (const n of ['channels', 'memberships', 'messages'] as const) {
      const sub = guest.collection(n).subscribe({})
      const rows = await sub.ready.then(() => sub.rows()).catch(() => [])
      expect(rows).toEqual([]) // deny keyed on ctx.userId — principal always falls back to a string
    }
    guest.close()
    ann.c.close()
  })

  it('concurrent removal of both owners cannot orphan the channel (per-channel serialization)', async () => {
    const { url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const cy = await newUser(url, 'cy@x.com', 'Cy')
    const ch = await ann.c.createChannel({ name: 'team' })
    await bob.c.joinChannel({ channelId: ch.id })
    await cy.c.joinChannel({ channelId: ch.id })
    await ann.c.setMemberRole({ channelId: ch.id, userId: bob.userId, role: 'owner' })

    // two owners removed concurrently: without the lock BOTH guards pass and cy is left ownerless
    const results = await Promise.allSettled([
      chatKit.members.remove(ch.id, ann.userId),
      chatKit.members.remove(ch.id, bob.userId),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    const remaining = await chatKit.members.of(ch.id)
    expect(remaining.some((m) => m.role === 'owner')).toBe(true) // never zero owners with members
    ann.c.close()
    bob.c.close()
    cy.c.close()
  })

  it('a sole-member owner cannot self-demote into an unmanageable channel', async () => {
    const { url } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const bob = await newUser(url, 'bob@x.com', 'Bob')
    const ch = await ann.c.createChannel({ name: 'solo' }) // ann is the ONLY member and owner

    await expect(
      ann.c.setMemberRole({ channelId: ch.id, userId: ann.userId, role: 'member' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' }) // the demoted target REMAINS a member

    await bob.c.joinChannel({ channelId: ch.id })
    await ann.c.setMemberRole({ channelId: ch.id, userId: bob.userId, role: 'owner' })
    const demoted = await ann.c.setMemberRole({ channelId: ch.id, userId: ann.userId, role: 'member' })
    expect(demoted.role).toBe('member') // fine once another owner exists
    ann.c.close()
    bob.c.close()
  })

  it('removeMember disconnects the kicked user so captured read filters cannot keep streaming', async () => {
    const { srv, url, chatKit } = await boot()
    const ann = await newUser(url, 'ann@x.com', 'Ann')
    const g = h.client(app, { url, role: 'guest' })
    const { token, userId: bobId } = await g.signUp({ email: 'bob@x.com', password: 'passpass', displayName: 'Bob' })
    g.close()

    const ch = await ann.c.createChannel({ name: 'secret', visibility: 'private' })
    await chatKit.members.add(ch.id, bobId)
    const bobConn = h.client(app, { url, role: 'user', params: { token }, reconnect: false })
    expect(await bobConn.whoami()).not.toBeNull()
    await waitFor(() => srv.local.connections.length === 2) // ann + bob live

    await chatKit.members.remove(ch.id, bobId)
    await waitFor(() => srv.local.connections.length === 1) // bob's connection was cut
    bobConn.close()
    ann.c.close()
  })
})

describe('plugin-chat — startup + guards', () => {
  it('chat() fails fast when the contract is missing a fragment; the kit throws before the server exists', async () => {
    const bare = defineContract({
      roles: { user: { clientToServer: { hello: { input: z.void(), output: z.object({ ok: z.boolean() }) } } } },
      plugins: [authContract()],
    })
    expect(() => chat({ contract: bare })).toThrow(/channels/)

    const chatKit = chat({ contract: app }) // valid contract, but no server yet
    await expect(chatKit.channels.create({ name: 'x' })).rejects.toThrow(/createSuperLineServer/)
  })
})
