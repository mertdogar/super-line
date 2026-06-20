import { Publisher, Subscriber } from 'zeromq'
import { afterEach, describe, expect, it } from 'vitest'
import { createZeroMqAdapter, createZeroMqProxy, type ZeroMqProxy } from '../src/index.js'
import type { Adapter } from '@super-line/core'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SETTLE = 200

describe('zeromq proxy mode', () => {
  const adapters: Adapter[] = []
  const proxies: ZeroMqProxy[] = []
  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((a) => a.close?.()))
    await Promise.all(proxies.splice(0).map((p) => p.stop()))
  })

  it('fans out through a central forwarder without self-echo', async () => {
    const proxy = await createZeroMqProxy({ frontendUrl: 'tcp://127.0.0.1:0', backendUrl: 'tcp://127.0.0.1:0' })
    proxies.push(proxy)
    const opts = { mode: 'proxy', frontendUrl: proxy.frontendUrl, backendUrl: proxy.backendUrl } as const
    const a = await createZeroMqAdapter(opts)
    const b = await createZeroMqAdapter(opts)
    adapters.push(a, b)

    const aGot: string[] = []
    const bGot: Array<[string, string]> = []
    a.onMessage((ch) => aGot.push(ch))
    b.onMessage((ch, p) => bGot.push([ch, Buffer.from(p).toString()]))
    a.subscribe('room') // a is subscribed too — the proxy would bounce a's own publish back
    b.subscribe('room')
    await delay(SETTLE)

    await a.publish('room', 'hi')
    await delay(SETTLE)

    expect(bGot).toEqual([['room', 'hi']])
    expect(aGot).toEqual(['room']) // exactly once: explicit loopback, proxy echo dropped via senderId
  })
})

describe('zeromq BYO sockets', () => {
  it('uses provided sockets and does not own their lifecycle', async () => {
    const pubA = new Publisher()
    const pubB = new Publisher()
    await pubA.bind('tcp://127.0.0.1:0')
    await pubB.bind('tcp://127.0.0.1:0')
    const subA = new Subscriber()
    const subB = new Subscriber()
    subA.connect(pubB.lastEndpoint!) // a receives from b
    subB.connect(pubA.lastEndpoint!) // b receives from a
    const a = await createZeroMqAdapter({ pub: pubA, sub: subA })
    const b = await createZeroMqAdapter({ pub: pubB, sub: subB })

    const got: string[] = []
    b.onMessage((ch) => got.push(ch))
    b.subscribe('byo')
    await delay(SETTLE)
    await a.publish('byo', 'x')
    await delay(SETTLE)
    expect(got).toEqual(['byo'])

    await a.close?.()
    await b.close?.()
    expect(pubA.closed).toBe(false) // BYO lifecycle not owned — sockets stay open
    expect(subA.closed).toBe(false)

    pubA.close()
    subA.close()
    pubB.close()
    subB.close()
  })
})
