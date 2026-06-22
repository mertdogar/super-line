import { describe, it, expect } from 'vitest'
import type { AuthOutcome, Handshake, RawConn } from '@super-line/core'
import { createLoopbackTransport } from '../src/index.js'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const dec = new TextDecoder()

function startServer(
  loopback: ReturnType<typeof createLoopbackTransport>,
  authenticate: (h: Handshake) => Promise<AuthOutcome>,
) {
  const accepted: Array<{ raw: RawConn; auth: AuthOutcome; messages: Uint8Array[]; closes: number[] }> = []
  loopback.server.start({
    authenticate,
    onConnection(raw, auth) {
      const rec = { raw, auth, messages: [] as Uint8Array[], closes: [] as number[] }
      raw.onMessage((b) => rec.messages.push(b))
      raw.onClose((code) => rec.closes.push(code))
      accepted.push(rec)
    },
  })
  return accepted
}

function dial(loopback: ReturnType<typeof createLoopbackTransport>, params: Record<string, string> = {}) {
  const events = { open: 0, messages: [] as Uint8Array[], closes: [] as number[], drains: 0 }
  const raw = loopback.client().connect(params, {
    onOpen: () => events.open++,
    onMessage: (b) => events.messages.push(b),
    onClose: (code) => events.closes.push(code),
    onDrain: () => events.drains++,
  })
  return { raw, events }
}

describe('loopback transport', () => {
  it('opens after authenticate resolves and round-trips bytes both ways', async () => {
    const loopback = createLoopbackTransport()
    const accepted = startServer(loopback, async () => ({ role: 'user', ctx: { id: '1' } }))
    const { raw, events } = dial(loopback, { role: 'user', token: 'abc' })

    await tick()
    expect(events.open).toBe(1)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.auth).toEqual({ role: 'user', ctx: { id: '1' } })

    raw.send('hello')
    await tick()
    expect(accepted[0]!.messages.map((b) => dec.decode(b))).toEqual(['hello'])

    accepted[0]!.raw.send('world')
    await tick()
    expect(events.messages.map((b) => dec.decode(b))).toEqual(['world'])
  })

  it('passes handshake params through as query', async () => {
    const loopback = createLoopbackTransport()
    let seen: Handshake | undefined
    startServer(loopback, async (h) => {
      seen = h
      return { role: h.query.role!, ctx: {} }
    })
    dial(loopback, { role: 'admin', token: 'xyz' })
    await tick()
    expect(seen?.transport).toBe('loopback')
    expect(seen?.query).toEqual({ role: 'admin', token: 'xyz' })
  })

  it('rejects the connection when authenticate throws (no onConnection, client gets 1006)', async () => {
    const loopback = createLoopbackTransport()
    const accepted = startServer(loopback, async () => {
      throw new Error('denied')
    })
    const { events } = dial(loopback)
    await tick()
    expect(accepted).toHaveLength(0)
    expect(events.open).toBe(0)
    expect(events.closes).toEqual([1006])
  })

  it('close() delivers 1000 to both ends and flips writable false', async () => {
    const loopback = createLoopbackTransport()
    const accepted = startServer(loopback, async () => ({ role: 'user', ctx: {} }))
    const { raw, events } = dial(loopback)
    await tick()

    raw.close()
    await tick()
    expect(events.closes).toEqual([1000])
    expect(accepted[0]!.closes).toEqual([1000])
    expect(raw.writable).toBe(false)
    raw.send('after close')
    await tick()
    expect(accepted[0]!.messages).toHaveLength(0)
  })

  it('terminate() delivers 1006', async () => {
    const loopback = createLoopbackTransport()
    const accepted = startServer(loopback, async () => ({ role: 'user', ctx: {} }))
    const { events } = dial(loopback)
    await tick()
    accepted[0]!.raw.terminate()
    await tick()
    expect(events.closes).toEqual([1006])
    expect(accepted[0]!.closes).toEqual([1006])
  })

  it('closes with 1006 when no server is listening', async () => {
    const loopback = createLoopbackTransport()
    const { events } = dial(loopback)
    await tick()
    expect(events.closes).toEqual([1006])
  })

  it('server.stop() drops live connections', async () => {
    const loopback = createLoopbackTransport()
    startServer(loopback, async () => ({ role: 'user', ctx: {} }))
    const { events } = dial(loopback)
    await tick()
    await loopback.server.stop()
    expect(events.closes).toEqual([1006])
  })

  it('drops a connection authenticating across server.stop() (no resurrection)', async () => {
    const loopback = createLoopbackTransport()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let onConnectionCalls = 0
    loopback.server.start({
      authenticate: async () => {
        await gate
        return { role: 'user', ctx: {} }
      },
      onConnection: () => onConnectionCalls++,
    })
    const { events } = dial(loopback)
    await tick() // authenticate is pending on the gate
    await loopback.server.stop()
    release()
    await tick()
    expect(onConnectionCalls).toBe(0)
    expect(events.closes).toEqual([1006])
  })
})
