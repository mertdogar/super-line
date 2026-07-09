// @vitest-environment jsdom
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { defineContract, eq } from '@super-line/core'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineHooks } from '@super-line/react'
import { memoryCollections } from '@super-line/collections-memory'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

const contract = defineContract({
  collections: {
    messages: { schema: z.object({ id: z.string(), channelId: z.string(), text: z.string() }), key: 'id' },
  },
  roles: {
    user: {
      clientToServer: {
        add: {
          input: z.object({ a: z.number(), b: z.number() }),
          output: z.object({ sum: z.number() }),
        },
      },
    },
  },
})

const { Provider, useRequest, useCollection } = createSuperLineHooks<typeof contract, 'user'>()

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  cleanup()
  for (const c of cleanups.splice(0)) await c()
})

async function boot(): Promise<{ client: SuperLineClient<typeof contract, 'user'>; srv: SuperLineServer<typeof contract, { role: 'user'; ctx: object }> }> {
  const server = http.createServer()
  const srv = createSuperLineServer(contract, {
    transports: [webSocketServerTransport({ server })],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    identify: () => 'tester',
    collections: memoryCollections(),
    policies: { messages: { read: () => undefined, write: () => true } },
  })
  srv.implement({ user: { add: async ({ a, b }) => ({ sum: a + b }) } })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
  })
  cleanups.push(() => client.close())
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { client, srv }
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
    expect(result.current.isLoading).toBe(false)
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
})
