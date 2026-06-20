import { afterEach, describe, expect, it } from 'vitest'
import { createZeroMqAdapter, type ZeroMqAdapter } from '../src/index.js'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SETTLE = 200 // SUB subscriptions propagate asynchronously (slow-joiner) — let the mesh form

describe('zeromq mesh adapter', () => {
  const open: ZeroMqAdapter[] = []
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close?.()))
  })
  const make = async (opts: Parameters<typeof createZeroMqAdapter>[0]): Promise<ZeroMqAdapter> => {
    const a = await createZeroMqAdapter(opts)
    open.push(a)
    return a
  }

  it('fans a published message to a subscribed peer', async () => {
    const a = await make({ bind: 'tcp://127.0.0.1:0' })
    const b = await make({ bind: 'tcp://127.0.0.1:0', peers: [a.endpoint] })
    const got: Array<[string, string]> = []
    b.onMessage((ch, p) => got.push([ch, Buffer.from(p).toString()]))
    b.subscribe('room1')
    await delay(SETTLE)
    await a.publish('room1', 'hello')
    await delay(SETTLE)
    expect(got).toEqual([['room1', 'hello']])
  })

  it('round-trips a binary payload as bytes', async () => {
    const a = await make({ bind: 'tcp://127.0.0.1:0' })
    const b = await make({ bind: 'tcp://127.0.0.1:0', peers: [a.endpoint] })
    const got: Uint8Array[] = []
    b.onMessage((_ch, p) => got.push(Buffer.from(p)))
    b.subscribe('bin')
    await delay(SETTLE)
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    await a.publish('bin', bytes)
    await delay(SETTLE)
    expect(got).toHaveLength(1)
    expect([...got[0]!]).toEqual([...bytes])
  })

  it('delivers only subscribed channels (native SUB filtering)', async () => {
    const a = await make({ bind: 'tcp://127.0.0.1:0' })
    const b = await make({ bind: 'tcp://127.0.0.1:0', peers: [a.endpoint] })
    const got: string[] = []
    b.onMessage((ch) => got.push(ch))
    b.subscribe('keep')
    await delay(SETTLE)
    await a.publish('drop', 'no')
    await a.publish('keep', 'yes')
    await delay(SETTLE)
    expect(got).toEqual(['keep'])
  })

  it('does not deliver a node its own published message twice', async () => {
    const a = await make({ bind: 'tcp://127.0.0.1:0' })
    const b = await make({ bind: 'tcp://127.0.0.1:0', peers: [a.endpoint] })
    const aGot: string[] = []
    a.onMessage((ch) => aGot.push(ch))
    a.subscribe('self') // a is subscribed and connected nowhere back to itself
    b.subscribe('self')
    await delay(SETTLE)
    await a.publish('self', 'x')
    await delay(SETTLE)
    expect(aGot).toEqual(['self']) // exactly one — the explicit loopback, no echo
  })
})
