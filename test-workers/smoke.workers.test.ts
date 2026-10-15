import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { SmokeNode } from './worker.js'

// Lane smoke test: a Durable Object with a hibernatable WebSocket can be exercised, evicted, and
// woken by a message. These are the platform facts the transport (T07) builds on; nothing here
// is super-line.

const open = async (stub: DurableObjectStub) => {
  const res = await stub.fetch('https://node/ws', { headers: { Upgrade: 'websocket' } })
  const ws = res.webSocket
  if (!ws) throw new Error('no websocket on the 101 response')
  ws.accept()
  return ws
}

const nextMessage = (ws: WebSocket) =>
  new Promise<string>((resolve) => ws.addEventListener('message', (ev) => resolve(String(ev.data)), { once: true }))

describe('workers lane smoke', () => {
  it('a hibernatable WebSocket survives eviction and a message wakes a NEW instance', async () => {
    const stub = env.SMOKE.get(env.SMOKE.idFromName(`smoke-${crypto.randomUUID()}`))
    const ws = await open(stub)

    const before = nextMessage(ws)
    ws.send('hello')
    expect(await before).toBe('echo:hello boots=1')

    await evictDurableObject(stub) // hibernates sockets rather than closing them

    const after = nextMessage(ws)
    ws.send('again')
    expect(await after).toBe('echo:again boots=2') // the constructor ran again, the socket did not close
    ws.close(1000, 'done')
  })

  it('SQLite storage persists across eviction and the attachment survives with the socket', async () => {
    const stub = env.SMOKE.get(env.SMOKE.idFromName(`smoke-${crypto.randomUUID()}`))
    const ws = await open(stub)
    const first = nextMessage(ws)
    ws.send('x')
    await first
    await evictDurableObject(stub)
    const sockets = await runInDurableObject(stub, (_instance: SmokeNode, state) =>
      state.getWebSockets().map((s) => s.deserializeAttachment() as { id: string }),
    )
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.id).toMatch(/^[0-9a-f-]{36}$/)
    const boots = await runInDurableObject(stub, (_instance: SmokeNode, state) =>
      state.storage.sql.exec<{ n: number }>('SELECT n FROM boots').one().n,
    )
    expect(boots).toBeGreaterThanOrEqual(2)
    ws.close(1000, 'done')
  })
})
