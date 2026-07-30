// @vitest-environment jsdom
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createElement, StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import * as z from 'zod'
import { defineContract, eq } from '@super-line/core'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import {
  createSuperLineHooks,
  SuperLineProvider,
  useLiveQuery,
  useCollection as boundUseCollection,
  useMaybeClient as boundUseMaybeClient,
} from '@super-line/react'
import { memoryCollections } from '@super-line/collections-memory'
import { crdtMemoryCollections, crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

const contract = defineContract({
  collections: {
    messages: { schema: z.object({ id: z.string(), channelId: z.string(), text: z.string() }), key: 'id' },
    scenes: { schema: z.object({ title: z.string().catch('untitled') }), crdt: { mode: 'document' } },
  },
  roles: {
    user: {
      clientToServer: {
        add: {
          input: z.object({ a: z.number(), b: z.number() }),
          output: z.object({ sum: z.number() }),
        },
        echo: {
          input: z.object({ tag: z.string(), delayMs: z.number() }),
          output: z.object({ tag: z.string() }),
        },
      },
    },
  },
})

const { Provider, useRequest, useCollection, useDoc } = createSuperLineHooks<typeof contract, 'user'>()

// Bind the module-level surface to this test's concrete contract BY CAST. Deliberate: `Register` is a
// program-wide singleton and the root typecheck program must stay unregistered (a second declaration
// anywhere is an interface merge conflict), so runtime tests narrow the never-typed exports by hand.
type Bound = ReturnType<typeof createSuperLineHooks<typeof contract, 'user'>>
const BoundProvider = SuperLineProvider as unknown as Bound['Provider']
const useBoundCollection = boundUseCollection as unknown as Bound['useCollection']
const useBoundMaybeClient = boundUseMaybeClient as unknown as Bound['useMaybeClient']

// Compile-time tripwire: in an unregistered program the provider props carry the guard marker. If this
// line ever errors, some root-typechecked file declared `Register` — which claims the ONE registration
// the whole program gets and silently rebinds every module-level consumer in it.
const _guardActive: '__superLineRegisterMissing' extends keyof Parameters<typeof SuperLineProvider>[0]
  ? true
  : false = true
void _guardActive

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  cleanup()
  for (const c of cleanups.splice(0)) await c()
})

async function boot(): Promise<{
  client: SuperLineClient<typeof contract, 'user'>
  srv: SuperLineServer<typeof contract, { role: 'user'; ctx: object }>
  counts: { add: number }
}> {
  const server = http.createServer()
  const counts = { add: 0 }
  const srv = createSuperLineServer(contract, {
    transports: [webSocketServerTransport({ server })],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    identify: () => 'tester',
    collections: memoryCollections(),
    crdtCollections: crdtMemoryCollections(),
    policies: {
      messages: { read: () => undefined, write: () => true },
      scenes: { read: () => true, write: () => true },
    },
  })
  srv.implement({
    user: {
      add: async ({ a, b }) => {
        counts.add++
        return { sum: a + b }
      },
      echo: async ({ tag, delayMs }) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        return { tag }
      },
    },
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    crdtCollections: crdtCollectionsClient(),
  })
  cleanups.push(() => client.close())
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { client, srv, counts }
}

function wrapper(client: SuperLineClient<typeof contract, 'user'>) {
  return ({ children }: { children: ReactNode }) => createElement(Provider, { client, children })
}

describe('react hooks', () => {
  it('useRequest performs a typed request and exposes state', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useRequest('add'), { wrapper: wrapper(client) })

    let returned: { sum: number } | undefined
    await act(async () => {
      returned = await result.current.call({ a: 2, b: 3 })
    })

    expect(returned).toEqual({ sum: 5 })
    expect(result.current.data).toEqual({ sum: 5 })
    expect(result.current.loading).toBe(false)
  })

  it('useRequest keeps the newest call, not the last one to resolve', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useRequest('echo'), { wrapper: wrapper(client) })

    // "slow" is fired first but lands last — its stale result must not clobber "fast".
    await act(async () => {
      const slow = result.current.call({ tag: 'slow', delayMs: 120 }).catch(() => undefined)
      const fast = result.current.call({ tag: 'fast', delayMs: 0 })
      await Promise.all([slow, fast])
    })

    expect(result.current.data).toEqual({ tag: 'fast' })
    expect(result.current.loading).toBe(false)
  })

  it('useCollection reflects a filtered snapshot, live server pushes, and client write-through', async () => {
    const { client, srv } = await boot()
    await srv.collection('messages').insert({ id: 'm1', channelId: 'general', text: 'seed' })

    const { result } = renderHook(() => useCollection('messages', { filter: eq('channelId', 'general') }), {
      wrapper: wrapper(client),
    })
    // snapshot + filter (the subscription is registered once this resolves)
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['m1']))

    // live server-side pushes: the matching one arrives, the non-matching one is filtered out
    await act(async () => {
      await srv.collection('messages').insert({ id: 'm2', channelId: 'random', text: 'offtopic' })
      await srv.collection('messages').insert({ id: 'm3', channelId: 'general', text: 'live' })
    })
    await waitFor(() => expect(result.current.rows.map((r) => r.id).sort()).toEqual(['m1', 'm3']))

    // client write-through (subscription already established → no subscribe/write race)
    await act(async () => {
      await result.current.insert({ id: 'm4', channelId: 'general', text: 'mine' })
    })
    await waitFor(() => expect(result.current.rows.map((r) => r.id).sort()).toEqual(['m1', 'm3', 'm4']))
  })

  it('module-level hooks read the singleton context SuperLineProvider feeds', async () => {
    const { client, srv } = await boot()
    await srv.collection('messages').insert({ id: 'g1', channelId: 'general', text: 'seed' })

    const { result } = renderHook(
      () => ({
        rows: useBoundCollection('messages', { filter: eq('channelId', 'general') }),
        client: useBoundMaybeClient(),
      }),
      { wrapper: ({ children }: { children: ReactNode }) => createElement(BoundProvider, { client, children }) },
    )

    // Both hooks see the SAME provider: the client lands and the subscription flows through it.
    expect(result.current.client).toBe(client)
    await waitFor(() => expect(result.current.rows.rows.map((r) => r.id)).toEqual(['g1']))

    await act(async () => {
      await result.current.rows.insert({ id: 'g2', channelId: 'general', text: 'mine' })
    })
    await waitFor(() => expect(result.current.rows.rows.map((r) => r.id).sort()).toEqual(['g1', 'g2']))
  })

  it('module-level hooks idle with no provider mounted at all', async () => {
    const { result } = renderHook(() => ({
      rows: useBoundCollection('messages'),
      client: useBoundMaybeClient(),
    }))
    expect(result.current.client).toBeNull()
    expect(result.current.rows.rows).toEqual([])
    await expect(result.current.rows.insert({ id: 'x', channelId: 'c', text: 't' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('useCollection survives StrictMode double-mounting (subscribe/close is re-entrant)', async () => {
    const { client, srv } = await boot()
    await srv.collection('messages').insert({ id: 's1', channelId: 'general', text: 'seed' })

    const { result } = renderHook(() => useCollection('messages', { filter: eq('channelId', 'general') }), {
      wrapper: ({ children }) =>
        createElement(StrictMode, null, createElement(Provider, { client, children })),
    })
    // The discarded first subscription must not have closed the surviving one's channel.
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['s1']))
    await act(async () => {
      await srv.collection('messages').insert({ id: 's2', channelId: 'general', text: 'live' })
    })
    await waitFor(() => expect(result.current.rows.map((r) => r.id).sort()).toEqual(['s1', 's2']))
  })
})

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

describe('useRequest (unified, TanStack-style)', () => {
  it('auto-fetches when an input is supplied and refetches when it changes', async () => {
    const { client } = await boot()
    const { result, rerender } = renderHook(({ input }) => useRequest('add', input), {
      wrapper: wrapper(client),
      initialProps: { input: { a: 2, b: 3 } },
    })
    await waitFor(() => expect(result.current.data).toEqual({ sum: 5 }))
    expect(result.current.loading).toBe(false)

    rerender({ input: { a: 3, b: 4 } })
    await waitFor(() => expect(result.current.data).toEqual({ sum: 7 }))
  })

  it('enabled:false holds fire until flipped', async () => {
    const { client, counts } = await boot()
    const { result, rerender } = renderHook(({ enabled }) => useRequest('add', { a: 1, b: 1 }, { enabled }), {
      wrapper: wrapper(client),
      initialProps: { enabled: false },
    })
    await act(() => settle())
    expect(result.current.data).toBeUndefined()
    expect(counts.add).toBe(0)

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.data).toEqual({ sum: 2 }))
  })

  it('the input-omitted form is manual: nothing auto-fires, call works, refetch rejects', async () => {
    const { client, counts } = await boot()
    const { result } = renderHook(() => useRequest('add'), { wrapper: wrapper(client) })
    await act(() => settle())
    expect(counts.add).toBe(0)
    expect(result.current.data).toBeUndefined()

    await act(async () => {
      await result.current.call({ a: 4, b: 4 })
    })
    expect(result.current.data).toEqual({ sum: 8 })
    await expect(result.current.refetch()).rejects.toThrow(/manual/)
  })

  it('auto-fetch fires exactly once under StrictMode double-mounting', async () => {
    const { client, counts } = await boot()
    const { result } = renderHook(() => useRequest('add', { a: 5, b: 5 }), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(StrictMode, null, createElement(Provider, { client, children })),
    })
    await waitFor(() => expect(result.current.data).toEqual({ sum: 10 }))
    await act(() => settle())
    expect(counts.add).toBe(1)
  })

  it('refetch re-runs with the hook input', async () => {
    const { client, counts } = await boot()
    const { result } = renderHook(() => useRequest('add', { a: 6, b: 6 }), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.data).toEqual({ sum: 12 }))

    await act(async () => {
      await result.current.refetch()
    })
    expect(counts.add).toBe(2)
    expect(result.current.data).toEqual({ sum: 12 })
  })
})

describe('useCollection (readiness, idle, handles, batch)', () => {
  it('ready distinguishes "snapshot not yet applied" from "genuinely empty"', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useCollection('messages'), { wrapper: wrapper(client) })
    expect(result.current.ready).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.rows).toEqual([])
  })

  it('query: null is the idle state — no subscription, no live surface, writes reject', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useCollection('messages', null), { wrapper: wrapper(client) })
    await act(() => settle())
    expect(result.current.ready).toBe(false)
    expect(result.current.rows).toEqual([])
    expect(result.current.sub).toBeUndefined()
    expect(result.current.handle).toBeUndefined()
    await expect(result.current.insert({ id: 'x', channelId: 'c', text: 't' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('exposes the underlying handle and live subscription, and batch applies atomically', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useCollection('messages'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.handle).toBeDefined()
    expect(result.current.sub).toBeDefined()
    expect(result.current.sub?.rows()).toBe(result.current.rows)

    await act(async () => {
      await result.current.batch([
        { type: 'insert', row: { id: 'b1', channelId: 'general', text: 'one' } },
        { type: 'insert', row: { id: 'b2', channelId: 'general', text: 'two' } },
      ])
    })
    await waitFor(() => expect(result.current.rows.map((r) => r.id).sort()).toEqual(['b1', 'b2']))

    await act(async () => {
      await result.current.batch([{ type: 'delete', id: 'b1' }])
    })
    await waitFor(() => expect(result.current.rows.map((r) => r.id)).toEqual(['b2']))
  })
})

describe('useLiveQuery (context-free low-level glue)', () => {
  it('drives rows/ready from a caller-built LiveRowSet and re-makes on deps change', async () => {
    const { client, srv } = await boot()
    await srv.collection('messages').insert({ id: 'q1', channelId: 'a', text: 'in-a' })
    await srv.collection('messages').insert({ id: 'q2', channelId: 'b', text: 'in-b' })

    const { result, rerender } = renderHook(
      ({ channel }) =>
        useLiveQuery(() => client.collection('messages').subscribe({ filter: eq('channelId', channel) }), [channel]),
      { initialProps: { channel: 'a' } },
    )
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.rows.map((r) => (r as { id: string }).id)).toEqual(['q1'])

    rerender({ channel: 'b' })
    await waitFor(() => expect(result.current.rows.map((r) => (r as { id: string }).id)).toEqual(['q2']))
  })

  it('a null make is the idle state', async () => {
    const { result } = renderHook(() => useLiveQuery(null, []))
    expect(result.current.rows).toEqual([])
    expect(result.current.ready).toBe(false)
  })
})

describe('useDoc (lazy ids, readiness, errors, handle)', () => {
  it('ready flips only after the catch-up snapshot: pre-existing content is whole before ready reads true', async () => {
    const { client, srv } = await boot()
    await srv.collection('scenes').create('s1', { title: 'hello' })

    const { result } = renderHook(() => useDoc('scenes', 's1'), { wrapper: wrapper(client) })
    // The sequencing contract the react-chat-transports editor needs: `ready` stays false until the
    // catch-up snapshot has applied, however early a (possibly empty) local snapshot exists — binding
    // an editor before `ready` is exactly the stray-merge bug this field prevents.
    expect(result.current.ready).toBe(false)
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.data).toEqual({ title: 'hello' })
    expect(result.current.handle).toBeDefined()
    expect(result.current.error).toBeUndefined()
  })

  it('a null id idles the hook; writes throw', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useDoc('scenes', null), { wrapper: wrapper(client) })
    await act(() => settle())
    expect(result.current.ready).toBe(false)
    expect(result.current.data).toBeUndefined()
    expect(result.current.handle).toBeUndefined()
    expect(() => result.current.set({ title: 'nope' })).toThrow()
  })

  it('an async resolver opens the doc it resolves to, re-running on deps change', async () => {
    const { client, srv } = await boot()
    await srv.collection('scenes').create('r1', { title: 'first' })
    await srv.collection('scenes').create('r2', { title: 'second' })

    const { result, rerender } = renderHook(
      ({ which }) =>
        useDoc(
          'scenes',
          async () => {
            await settle(20)
            return which
          },
          [which],
        ),
      { wrapper: wrapper(client), initialProps: { which: 'r1' } },
    )
    await waitFor(() => expect(result.current.data).toEqual({ title: 'first' }))

    rerender({ which: 'r2' })
    await waitFor(() => expect(result.current.data).toEqual({ title: 'second' }))
    expect(result.current.error).toBeUndefined()
  })

  it('an absent doc surfaces on error instead of hanging invisible', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useDoc('scenes', 'missing'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.error).toBeDefined())
    expect(result.current.ready).toBe(false)
    expect(result.current.error).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('a resolver that resolves null idles instead of opening', async () => {
    const { client } = await boot()
    const { result } = renderHook(() => useDoc('scenes', async () => null, []), { wrapper: wrapper(client) })
    await act(() => settle())
    expect(result.current.ready).toBe(false)
    expect(result.current.handle).toBeUndefined()
    expect(result.current.error).toBeUndefined()
  })
})
