// @vitest-environment jsdom
import { createElement, StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract } from '@super-line/plugin-chat'
import { chatClient, type ChatClient } from '@super-line/plugin-chat/client'
import { chat } from '@super-line/plugin-chat/server'
import {
  createChatHooks,
  type ChatBinding,
  ChatProvider as SharedChatProvider,
  useChat as sharedUseChat,
  useChannels as sharedUseChannels,
  useMe as sharedUseMe,
} from '@super-line/plugin-chat/react'
import { SuperLineProvider } from '@super-line/react'
import type { SuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { createHarness } from '../../server/test/harness.js'

const app = defineContract({
  roles: { user: {} },
  plugins: [authContract(), chatContract()],
})

const { ChatProvider, useMessages, useMessageParts, useMembers, useChannelResources, useMe, useChannelBusy } =
  createChatHooks<typeof app>()

// The module-level surface, cast-bound to this test's contract (Register stays undeclared in the root
// typecheck program — see the tripwire in packages/react/test/hooks.test.ts). The base context is fed
// through @super-line/react's SuperLineProvider, exactly as SuperLineAuthProvider does in production.
type ChatB = ChatBinding<typeof app>
type Client = SuperLineClient<typeof app, 'user'>
const BaseProvider = SuperLineProvider as unknown as (props: {
  client: Client | null
  children?: ReactNode
}) => ReactNode
const AutoChatProvider = SharedChatProvider as unknown as (props: {
  chat?: ChatClient<typeof app>
  children?: ReactNode
}) => ReactNode
const useBoundChat = sharedUseChat as unknown as () => ChatClient<typeof app> | null
const useBoundChannels = sharedUseChannels as unknown as ChatB['useChannels']
const useBoundMe = sharedUseMe as unknown as ChatB['useMe']

const h = createHarness()
afterEach(() => {
  cleanup()
  h.dispose()
})

async function boot() {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const chatKit = chat({ contract: app })
  const { url } = await h.server(app, {
    nodeKey: 'chat-react-test',
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin, chatKit.plugin],
  })
  return { url }
}

async function newChat(url: string, email: string): Promise<{ chat: ChatClient<typeof app>; userId: string }> {
  const g = h.client(app, { url, role: 'guest' })
  const { token, userId } = await g.signUp({ email, password: 'passpass', displayName: email })
  g.close()
  const c = h.client(app, { url, role: 'user', params: { token } })
  const cc = chatClient(c, { userId })
  await cc.ready
  return { chat: cc, userId }
}

// every test renders under StrictMode: effects double-invoke, so a store minted during render (the
// orphan leak) or closed by the remount cleanup (the dead-store bug) fails these live assertions
const wrap = (client: ChatClient<typeof app>) =>
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return createElement(StrictMode, null, createElement(ChatProvider, { chat: client, children }))
  }

describe('plugin-chat/react — null-tolerant hooks under StrictMode', () => {
  it('useMessages idles at [] on null, goes live on a real id, and returns to idle', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'ann@x.com')
    const ch = await ann.chat.createChannel({ name: 'general' })
    await ann.chat.send(ch.id, 'first')

    const view = renderHook(({ id }: { id: string | null }) => useMessages(id), {
      initialProps: { id: null as string | null },
      wrapper: wrap(ann.chat),
    })
    expect(view.result.current).toEqual([])

    view.rerender({ id: ch.id })
    await waitFor(() => expect(view.result.current).toHaveLength(1))
    // live delivery still works after StrictMode's mount→unmount→mount cycle
    await ann.chat.send(ch.id, 'second')
    await waitFor(() => expect(view.result.current).toHaveLength(2))

    view.rerender({ id: null })
    await waitFor(() => expect(view.result.current).toEqual([]))
    ann.chat.close()
  })

  it('useMessageParts idles at [] until both ids are present', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'parts@x.com')
    const view = renderHook(
      ({ chId, msgId }: { chId: string | null; msgId: string | null }) => useMessageParts(chId, msgId),
      { initialProps: { chId: null as string | null, msgId: null as string | null }, wrapper: wrap(ann.chat) },
    )
    expect(view.result.current).toEqual([])
    view.rerender({ chId: 'c1', msgId: null })
    expect(view.result.current).toEqual([])
    ann.chat.close()
  })

  it('useMembers and useChannelResources are null-tolerant and go live on a real id', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'members@x.com')
    const ch = await ann.chat.createChannel({ name: 'roster' })

    const view = renderHook(
      ({ id }: { id: string | null }) => ({ members: useMembers(id), resources: useChannelResources(id) }),
      { initialProps: { id: null as string | null }, wrapper: wrap(ann.chat) },
    )
    expect(view.result.current.members).toEqual([])
    expect(view.result.current.resources).toEqual([])

    view.rerender({ id: ch.id })
    await waitFor(() => expect(view.result.current.members).toHaveLength(1))
    expect(view.result.current.members[0]).toMatchObject({
      displayName: 'members@x.com',
      online: true,
      connectedAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
    })
    ann.chat.close()
  })

  it('every store minted is closed on unmount — no orphans from StrictMode/discarded renders', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'leak@x.com')
    const ch = await ann.chat.createChannel({ name: 'leak' })

    let opened = 0
    let closed = 0
    const spied: ChatClient<typeof app> = {
      ...ann.chat,
      messages: (id, o) => {
        opened++
        const store = ann.chat.messages(id, o)
        return {
          ...store,
          close: () => {
            closed++
            store.close()
          },
        }
      },
    }

    const view = renderHook(() => useMessages(ch.id), { wrapper: wrap(spied) })
    await waitFor(() => expect(opened).toBeGreaterThan(0))
    view.unmount()
    await waitFor(() => expect(closed).toBe(opened))
    ann.chat.close()
  })

  it('useMe resolves the signed-in userId once ready', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'me@x.com')
    const view = renderHook(() => useMe(), { wrapper: wrap(ann.chat) })
    await waitFor(() => expect(view.result.current.ready).toBe(true))
    expect(view.result.current.userId).toBe(ann.userId)
    ann.chat.close()
  })

  it('module-level ChatProvider auto-builds from the shared context, resolves me via whoami, rebuilds on client swap, and idles on null', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'auto-ann@x.com')
    await ann.chat.createChannel({ name: 'general' })
    const bo = await newChat(url, 'auto-bo@x.com')

    // Raw clients for the SHARED context — the auto-provider must build its own ChatClient (no userId
    // passed anywhere: the omit→whoami path is what resolves identity).
    const rawFor = async (email: string): Promise<Client> => {
      const g = h.client(app, { url, role: 'guest' })
      const { token } = await g.signIn({ email, password: 'passpass' })
      g.close()
      return h.client(app, { url, role: 'user', params: { token } })
    }
    const annRaw = await rawFor('auto-ann@x.com')
    const boRaw = await rawFor('auto-bo@x.com')

    // renderHook's initialProps feed the HOOK, not the wrapper — the changing client rides a box the
    // wrapper reads on every render, and rerender() re-executes the wrapper.
    const box = { client: annRaw as Client | null }
    const view = renderHook(
      () => ({ chat: useBoundChat(), channels: useBoundChannels(), me: useBoundMe() }),
      {
        wrapper: ({ children }: { children?: ReactNode }) =>
          createElement(
            StrictMode,
            null,
            createElement(BaseProvider, { client: box.client, children: createElement(AutoChatProvider, { children }) }),
          ),
      },
    )

    // Auto-built: hooks light up with no chat prop and no hand-rolled bridge.
    await waitFor(() => expect(view.result.current.chat).not.toBeNull())
    await waitFor(() => expect(view.result.current.channels.map((c) => (c as { name: string }).name)).toEqual(['general']))
    await waitFor(() => expect(view.result.current.me.ready).toBe(true))
    expect(view.result.current.me.userId).toBe(ann.userId)

    // Client swap (session replacement) → the provider closes+rebuilds → identity flips.
    box.client = boRaw
    view.rerender()
    await waitFor(() => expect(view.result.current.me.userId).toBe(bo.userId))

    // Null client (signed out) → chat gone, hooks idle.
    box.client = null
    view.rerender()
    await waitFor(() => expect(view.result.current.chat).toBeNull())
    expect(view.result.current.channels).toEqual([])

    ann.chat.close()
    bo.chat.close()
    annRaw.close()
    boRaw.close()
  })

  it('module-level ChatProvider adopts an owned instance and never closes it on unmount', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'adopt@x.com')
    const ch = await ann.chat.createChannel({ name: 'mine' })

    const view = renderHook(() => useBoundChannels(), {
      wrapper: ({ children }: { children?: ReactNode }) =>
        createElement(AutoChatProvider, { chat: ann.chat, children }),
    })
    await waitFor(() => expect(view.result.current).toHaveLength(1))

    view.unmount()
    // The instance is the app's: still alive and usable after the provider is gone.
    await ann.chat.send(ch.id, 'still alive')
    ann.chat.close()
  })

  it('useChannelBusy flips true while a message streams and false on settle', async () => {
    const { url } = await boot()
    const ann = await newChat(url, 'busy@x.com')
    const ch = await ann.chat.createChannel({ name: 'busy' })

    const view = renderHook(() => useChannelBusy(ch.id), { wrapper: wrap(ann.chat) })
    await waitFor(() => expect(view.result.current).toBe(false))

    const writer = await ann.chat.stream(ch.id)
    writer.push({ type: 'part_start', key: 't', partType: 'text' }, { type: 'delta', key: 't', text: 'working' })
    await writer.flush()
    await waitFor(() => expect(view.result.current).toBe(true))

    await writer.finalize()
    await waitFor(() => expect(view.result.current).toBe(false))
    ann.chat.close()
  })
})
