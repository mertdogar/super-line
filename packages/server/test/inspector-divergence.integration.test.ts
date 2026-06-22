import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WebSocket } from 'ws'
import { defineContract, INSPECTOR_SUBPROTOCOL } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'

// The server is the authority on whether the inspector is enabled. A transport that negotiates the
// inspector subprotocol must NOT open an inspector the server didn't enable (privilege divergence).
const contract = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function boot(serverInspector: boolean, transportInspector: boolean): Promise<string> {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(contract, {
    transports: [webSocketServerTransport({ server: httpServer, inspector: transportInspector })],
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    inspector: serverInspector,
  })
  await new Promise<void>((r) => httpServer.listen(0, r))
  const { port } = httpServer.address() as AddressInfo
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((r) => httpServer.close(() => r()))
  })
  return `ws://127.0.0.1:${port}`
}

describe('inspector flag divergence (server is authoritative)', () => {
  it('refuses an inspector the transport offered but the server did not enable', async () => {
    const url = await boot(false, true) // transport echoes the subprotocol; server inspector OFF
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => {}) // may open (subprotocol echoed) — but the server must then close it
      ws.on('close', () => resolve('closed'))
      ws.on('error', () => resolve('error'))
    })
    expect(['closed', 'error']).toContain(outcome)
  })

  it('allows the inspector when both the server and the transport enable it', async () => {
    const url = await boot(true, true)
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true))
      ws.on('close', () => resolve(false))
      ws.on('error', () => resolve(false))
    })
    expect(opened).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(ws.readyState).toBe(WebSocket.OPEN) // stays open, not refused
    ws.close()
  })
})
