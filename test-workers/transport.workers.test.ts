import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { INSPECTOR_SUBPROTOCOL } from '@super-line/core'
import type { RawNode } from './worker.js'

// transport-cloudflare's contract tests: the transport-neutral cases transport-websocket pins, run against a
// real Durable Object in workerd.

const node = () => env.RAW.get(env.RAW.idFromName(`raw-${crypto.randomUUID()}`))
const upgrade = (stub: DurableObjectStub, query: string, protocols?: string) =>
  stub.fetch(`https://node/?${query}`, {
    headers: { Upgrade: 'websocket', ...(protocols ? { 'Sec-WebSocket-Protocol': protocols } : {}) },
  })
const nextMessage = (ws: WebSocket) =>
  new Promise<string>((resolve) => ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true }))
const closed = (ws: WebSocket) =>
  new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }), { once: true }),
  )

describe('cloudflare transport', () => {
  it('builds a Handshake from the request and round-trips bytes both ways', async () => {
    const stub = node()
    const res = await upgrade(stub, 'role=user&uid=alice')
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ws.accept()
    const reply = nextMessage(ws)
    ws.send('hello')
    expect(await reply).toBe('HELLO')
    const [handshake, accepted] = await runInDurableObject(stub, (i: RawNode) => [i.handshakes[0], i.accepted[0]] as const)
    expect(handshake).toMatchObject({ transport: 'cloudflare', query: { role: 'user', uid: 'alice' } })
    expect(handshake?.headers.upgrade).toBe('websocket')
    expect(accepted).toMatchObject({ role: 'user', ctx: { uid: 'alice' } })
    expect(accepted?.connectionId).toMatch(/^[0-9a-f-]{36}$/) // the transport names the connection
    ws.close(1000, 'done')
  })

  it('rejects with a plain 401 (no upgrade) when authenticate throws', async () => {
    const res = await upgrade(node(), 'role=user&reject=1')
    expect(res.status).toBe(401)
    expect(res.webSocket).toBeNull()
  })

  it('accepts a reserved (subprotocol) connection without the host authenticate', async () => {
    const stub = node()
    const res = await upgrade(stub, 'pw=open%20sesame', INSPECTOR_SUBPROTOCOL)
    expect(res.status).toBe(101)
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(INSPECTOR_SUBPROTOCOL)
    res.webSocket!.accept()
    const [handshakes, accepted] = await runInDurableObject(stub, (i: RawNode) => [i.handshakes.length, i.accepted[0]] as const)
    expect(handshakes).toBe(0)
    expect(accepted).toMatchObject({ role: 'inspector', ctx: { admin: true } })
    res.webSocket!.close(1000, 'done')
  })

  it('refuses a reserved connection AFTER the upgrade with 4401, so a client can tell it from a dead host', async () => {
    const res = await upgrade(node(), 'pw=wrong', INSPECTOR_SUBPROTOCOL)
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    const done = closed(ws)
    ws.accept()
    expect(await done).toEqual({ code: 4401, reason: 'bad inspector password' })
  })

  it('client pings are answered by the platform, not the server — so they never wake a hibernated node', async () => {
    const stub = node()
    const res = await upgrade(stub, 'role=user&uid=alice')
    const ws = res.webSocket!
    ws.accept()
    const reply = nextMessage(ws)
    ws.send('{"t":"ping"}')
    expect(await reply).toBe('{"t":"pong"}') // the server would have echoed it upper-cased
    const answered = await runInDurableObject(stub, (_i, state) => state.getWebSocketAutoResponseTimestamp(state.getWebSockets()[0]!))
    expect(answered).not.toBeNull()
    ws.close(1000, 'done')
  })
})
