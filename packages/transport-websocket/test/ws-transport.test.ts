import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { INSPECTOR_SUBPROTOCOL, type AuthOutcome, type Handshake, type RawConn, type ReservedConnection } from '@super-line/core'
import { webSocketServerTransport, webSocketClientTransport } from '../src/index.js'

const dec = new TextDecoder()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function listen(
  authenticate: (h: Handshake) => Promise<AuthOutcome>,
  onConnection: (raw: RawConn, auth: AuthOutcome) => void,
  reserved?: ReservedConnection[],
) {
  const server = http.createServer()
  const transport = webSocketServerTransport({ server })
  await transport.start({ authenticate, onConnection, reserved })
  await new Promise<void>((r) => server.listen(0, r))
  const { port } = server.address() as AddressInfo
  cleanups.push(async () => {
    await transport.stop()
    await new Promise<void>((r) => server.close(() => r()))
  })
  return { url: `ws://127.0.0.1:${port}`, transport }
}

describe('websocket transport', () => {
  it('builds a Handshake from the URL query and round-trips bytes both ways', async () => {
    let seen: Handshake | undefined
    const serverMsgs: string[] = []
    const { url } = await listen(
      async (h) => {
        seen = h
        return { role: h.query.role!, ctx: { token: h.query.token } }
      },
      (raw) => {
        raw.onMessage((b) => {
          serverMsgs.push(dec.decode(b))
          raw.send('pong:' + dec.decode(b))
        })
      },
    )

    const clientMsgs: string[] = []
    let opened = false
    const transport = webSocketClientTransport({ url })
    const raw = transport.connect(
      { role: 'user', token: 'abc' },
      {
        onOpen: () => (opened = true),
        onMessage: (b) => clientMsgs.push(dec.decode(b)),
        onClose: () => {},
        onDrain: () => {},
      },
    )
    cleanups.unshift(() => raw.close()) // close the client before the server it connects to

    await waitFor(() => opened)
    expect(seen?.transport).toBe('websocket')
    expect(seen?.query).toMatchObject({ role: 'user', token: 'abc' })

    raw.send('hi')
    await waitFor(() => clientMsgs.length === 1)
    expect(serverMsgs).toEqual(['hi'])
    expect(clientMsgs).toEqual(['pong:hi'])
  })

  it('rejects with a 401 (no upgrade) when authenticate throws', async () => {
    let connected = 0
    const { url } = await listen(
      async () => {
        throw new Error('denied')
      },
      () => connected++,
    )

    const ws = new WebSocket(`${url}/?role=user`)
    const result = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'))
      ws.on('error', () => resolve('error'))
      ws.on('unexpected-response', (_req, res) => resolve('status:' + res.statusCode))
    })
    expect(['error', 'status:401']).toContain(result)
    expect(connected).toBe(0)
  })

  it('accepts a reserved (subprotocol) connection without authenticate', async () => {
    let authCalls = 0
    let inspectorAuth: AuthOutcome | undefined
    const { url } = await listen(
      async () => {
        authCalls++
        return { role: 'user', ctx: {} }
      },
      (_raw, auth) => {
        inspectorAuth = auth
      },
      [{ role: 'inspector', subprotocol: INSPECTOR_SUBPROTOCOL }],
    )

    const ws = new WebSocket(url, 'superline.inspector.v1')
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })
    await waitFor(() => inspectorAuth !== undefined)
    expect(inspectorAuth?.role).toBe('inspector')
    expect(authCalls).toBe(0)
    ws.close()
  })
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
