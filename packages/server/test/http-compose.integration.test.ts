import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EventSource } from 'eventsource'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { httpServerTransport, httpClientTransport } from '@super-line/transport-http'

const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
      },
    },
  },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function waitFor(pred: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('WS + HTTP transports compose on one http.Server', () => {
  it('serves a WebSocket client and an HTTP (SSE) client side by side', async () => {
    const httpServer = http.createServer()
    const srv = createSuperLineServer(contract, {
      transports: [webSocketServerTransport({ server: httpServer }), httpServerTransport({ server: httpServer })],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
    })
    srv.implement({ user: { echo: async ({ text }) => ({ text: text.toUpperCase() }) } })
    await new Promise<void>((r) => httpServer.listen(0, r))
    const { port } = httpServer.address() as AddressInfo

    const wsClient = createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url: `ws://127.0.0.1:${port}` }),
      role: 'user',
    })
    const httpClient = createSuperLineClient(contract, {
      transport: httpClientTransport({ url: `http://127.0.0.1:${port}`, EventSource }),
      role: 'user',
    })
    cleanups.unshift(() => wsClient.close())
    cleanups.unshift(() => httpClient.close())
    cleanups.push(() => srv.close())
    cleanups.push(async () => {
      await new Promise<void>((r) => httpServer.close(() => r()))
    })

    expect(await wsClient.echo({ text: 'a' })).toEqual({ text: 'A' })
    expect(await httpClient.echo({ text: 'b' })).toEqual({ text: 'B' })
    await waitFor(() => srv.local.connections.length === 2) // both transports' conns are live on the same server
  })
})
