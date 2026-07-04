import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WebSocket } from 'ws'
import { defineContract, INSPECTOR_SUBPROTOCOL } from '@super-line/core'
import { inspector } from '@super-line/plugin-inspector'
import { createSuperLineServer, type SuperLinePlugin } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'

// The server is the single authority on the inspector: the transport negotiates the `superline.inspector.v1`
// subprotocol ONLY when the server declares it (by mounting the inspector plugin, which contributes the
// reserved connection class). No inspector plugin → the subprotocol is never advertised, so the handshake fails.
const contract = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function boot(plugins: SuperLinePlugin[]): Promise<string> {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(contract, {
    transports: [webSocketServerTransport({ server: httpServer })],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    plugins,
  })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const { port } = httpServer.address() as AddressInfo
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((r) => httpServer.close(() => r()))
  })
  return `ws://127.0.0.1:${port}`
}

describe('inspector negotiation (server is authoritative via the plugin)', () => {
  it('does not negotiate the inspector subprotocol without the inspector plugin', async () => {
    const url = await boot([]) // no inspector plugin → the server declares no reserved class
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('close', () => resolve('closed'))
      ws.on('error', () => resolve('error')) // ws rejects when the server doesn't select the requested subprotocol
    })
    expect(['closed', 'error']).toContain(outcome)
  })

  it('negotiates the inspector subprotocol when the inspector plugin is mounted', async () => {
    const url = await boot([inspector()])
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true))
      ws.on('close', () => resolve(false))
      ws.on('error', () => resolve(false))
    })
    expect(opened).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
