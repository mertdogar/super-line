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

  /**
   * A failed dial is the ONLY close signal the core gets for a server that is not up yet, and it is what
   * schedules the reconnect. The two cases below are the two real-world event sequences; the fakes pin them
   * deterministically because which one you get depends on the runtime — **Node 22's undici fires `error`
   * alone**, while browsers and Node 24 fire `error` then `close`. A live refused-dial test would therefore
   * pass on a Node 24 dev machine while the Node 22 containers this repo actually ships stayed broken.
   */
  class ScriptedWs {
    static OPEN = 1
    static script: 'error-only' | 'error-then-close' = 'error-only'
    readyState = 0
    binaryType = ''
    onopen: (() => void) | null = null
    onmessage: ((event: unknown) => void) | null = null
    onclose: ((event: { code: number }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) {
      queueMicrotask(() => {
        this.onerror?.()
        if (ScriptedWs.script === 'error-then-close') this.onclose?.({ code: 1006 })
      })
    }
    send(): void {}
    close(): void {}
  }

  const dialWith = async (script: 'error-only' | 'error-then-close'): Promise<number[]> => {
    ScriptedWs.script = script
    const closes: number[] = []
    let opened = false
    webSocketClientTransport({
      url: 'ws://127.0.0.1:1',
      WebSocket: ScriptedWs as unknown as typeof WebSocket,
    }).connect(
      { role: 'user' },
      {
        onOpen: () => {
          opened = true
        },
        onMessage: () => {},
        onClose: (code) => closes.push(code),
        onDrain: () => {},
      },
    )
    await waitFor(() => closes.length > 0)
    await new Promise((r) => setTimeout(r, 20)) // let a second announcement land, if one is coming
    expect(opened).toBe(false)
    return closes
  }

  it('announces a close when the socket reports only an error (Node 22 undici)', async () => {
    expect(await dialWith('error-only')).toEqual([1006])
  })

  it('announces a close exactly once when the socket fires both error and close', async () => {
    // Two announcements would schedule two reconnects and double the dial rate on every failure.
    expect(await dialWith('error-then-close')).toEqual([1006])
  })

  it('reports a real refused dial as a close', async () => {
    // bind and immediately release a port, so nothing is listening on an address that was valid a moment ago
    const probe = http.createServer()
    await new Promise<void>((r) => probe.listen(0, r))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((r) => probe.close(() => r()))

    const closes: number[] = []
    webSocketClientTransport({ url: `ws://127.0.0.1:${port}` }).connect(
      { role: 'user' },
      { onOpen: () => {}, onMessage: () => {}, onClose: (code) => closes.push(code), onDrain: () => {} },
    )
    await waitFor(() => closes.length > 0)
    expect(closes).toEqual([1006])
  })
})

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
