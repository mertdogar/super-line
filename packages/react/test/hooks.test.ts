// @vitest-environment jsdom
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSocketServer } from '@super-line/server'
import { createClient, type Client } from '@super-line/client'
import { createSocketReact } from '@super-line/react'

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

const { Provider, useRequest } = createSocketReact<typeof contract, 'user'>()

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  cleanup()
  for (const c of cleanups.splice(0)) await c()
})

async function boot(): Promise<Client<typeof contract, 'user'>> {
  const server = http.createServer()
  const srv = createSocketServer(contract, {
    server,
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
  })
  srv.implement({ user: { add: async ({ a, b }) => ({ sum: a + b }) } })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const client = createClient(contract, { url, role: 'user' })
  cleanups.push(() => client.close())
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return client
}

function wrapper(client: Client<typeof contract, 'user'>) {
  return ({ children }: { children: ReactNode }) => createElement(Provider, { client, children })
}

describe('react hooks', () => {
  it('useRequest performs a typed request and exposes state', async () => {
    const client = await boot()
    const { result } = renderHook(() => useRequest('add'), { wrapper: wrapper(client) })

    let returned: { sum: number } | undefined
    await act(async () => {
      returned = await result.current.call({ a: 2, b: 3 })
    })

    expect(returned).toEqual({ sum: 5 })
    expect(result.current.data).toEqual({ sum: 5 })
    expect(result.current.isLoading).toBe(false)
  })
})
