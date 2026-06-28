// @vitest-environment jsdom
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { createSuperLineClient, type SuperLineClient } from '@super-line/client'
import { createSuperLineHooks } from '@super-line/react'
import { memoryStoreClient, memoryStoreServer } from '@super-line/store-memory'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

const contract = defineContract({
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

const { Provider, useRequest, useResource } = createSuperLineHooks<typeof contract, 'user'>()

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
    stores: { docs: memoryStoreServer() },
  })
  srv.implement({ user: { add: async ({ a, b }) => ({ sum: a + b }) } })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createSuperLineClient(contract, {
    transport: webSocketClientTransport({ url }),
    role: 'user',
    stores: { docs: memoryStoreClient() },
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

  it('useResource catches up to the server snapshot and writes through', async () => {
    const { client, srv } = await boot()
    await srv.store('docs').create('d1', { v: 1 }, { tester: { read: true, write: true } })

    const { result } = renderHook(() => useResource<{ v: number }>('docs', 'd1'), { wrapper: wrapper(client) })

    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }))

    await act(async () => {
      result.current.set({ v: 2 })
    })
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }))
  })

  it('useResource surfaces deleted=true when the server removes the resource', async () => {
    const { client, srv } = await boot()
    await srv.store('docs').create('ddel', { v: 1 }, { tester: { read: true, write: true } })

    const { result } = renderHook(() => useResource<{ v: number }>('docs', 'ddel'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }))
    expect(result.current.deleted).toBe(false)

    await act(async () => {
      await srv.store('docs').delete('ddel')
    })
    await waitFor(() => expect(result.current.deleted).toBe(true))
  })

  it('useResource exposes delete(path) for surgical key removal', async () => {
    const { client, srv } = await boot()
    await srv.store('docs').create('d2', { keep: 1, drop: 2 }, { tester: { read: true, write: true } })

    const { result } = renderHook(() => useResource<{ keep: number; drop?: number }>('docs', 'd2'), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.data).toEqual({ keep: 1, drop: 2 }))

    await act(async () => {
      result.current.delete(['drop'])
    })
    await waitFor(() => expect(result.current.data).toEqual({ keep: 1 }))
  })
})
