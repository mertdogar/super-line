import { afterEach, describe, expect, it } from 'vitest'
import { createLibp2p, type Libp2p } from 'libp2p'
import { memory } from '@libp2p/memory'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import type { AuthOutcome, Handshake, RawConn } from '@super-line/core'
import { libp2pServerTransport, libp2pClientTransport } from '../src/index.js'
import { wrap } from '../src/framing.js'

let memSeq = 0
async function makeNode(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: [`/memory/sl-txu-${++memSeq}`] } : {},
    transports: [memory()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  })
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(10)
  }
}

interface Accepted {
  raw: RawConn
  auth: AuthOutcome
  messages: Uint8Array[]
  closes: number[]
}

async function listen(authenticate: (h: Handshake) => Promise<AuthOutcome>) {
  const serverNode = await makeNode(true)
  const accepted: Accepted[] = []
  const transport = libp2pServerTransport({ node: serverNode })
  await transport.start({
    authenticate,
    onConnection(raw, auth) {
      const rec: Accepted = { raw, auth, messages: [], closes: [] }
      raw.onMessage((b) => rec.messages.push(b))
      raw.onClose((code) => rec.closes.push(code))
      accepted.push(rec)
    },
  })
  cleanups.push(() => transport.stop())
  cleanups.push(() => serverNode.stop())
  return { serverNode, accepted }
}

function dial(serverNode: Libp2p, clientNode: Libp2p, params: Record<string, string> = { role: 'user' }) {
  const events = { opened: false, messages: [] as Uint8Array[], closes: [] as number[] }
  const raw = libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() }).connect(params, {
    onOpen: () => (events.opened = true),
    onMessage: (b) => events.messages.push(b),
    onClose: (c) => events.closes.push(c),
    onDrain: () => {},
  })
  return { raw, events }
}

const ok = async (): Promise<AuthOutcome> => ({ role: 'user', ctx: {} })
const dec = new TextDecoder()

describe('libp2p transport', () => {
  it('lpStream reassembles frame boundaries across yamux/memory chunking', async () => {
    const serverNode = await makeNode(true)
    const clientNode = await makeNode(false)
    cleanups.push(() => serverNode.stop())
    cleanups.push(() => clientNode.stop())
    const received: number[] = []
    const done = new Promise<void>((resolve) => {
      void serverNode.handle('/sl-frame-test/1.0.0', (stream) => {
        void (async () => {
          const lp = wrap(stream)
          for (let i = 0; i < 3; i++) received.push((await lp.read()).subarray().byteLength)
          resolve()
        })()
      })
    })
    await tick(50)
    const stream = await clientNode.dialProtocol(serverNode.getMultiaddrs(), '/sl-frame-test/1.0.0')
    const lp = wrap(stream)
    await lp.write(new Uint8Array(3).fill(1))
    await lp.write(new Uint8Array(200_000).fill(7)) // > memory's 64KB chunk size -> arrives as several yamux frames
    await lp.write(new Uint8Array(5).fill(2))
    await done
    expect(received).toEqual([3, 200_000, 5]) // exact boundaries preserved
  })

  it('builds a Handshake from the first frame and round-trips bytes', async () => {
    let seen: Handshake | undefined
    const { serverNode, accepted } = await listen(async (h) => {
      seen = h
      return { role: h.query.role!, ctx: {} }
    })
    const clientNode = await makeNode(false)
    cleanups.push(() => clientNode.stop())
    const { raw, events } = dial(serverNode, clientNode, { role: 'user', name: 'alice' })

    await waitFor(() => events.opened && accepted.length === 1)
    expect(seen?.transport).toBe('libp2p')
    expect(seen?.query).toEqual({ role: 'user', name: 'alice' })
    expect(seen?.peer?.id).toBe(clientNode.peerId.toString())
    expect(seen?.peer?.addr).toBeTruthy()

    raw.send('ping')
    await waitFor(() => accepted[0]!.messages.length === 1)
    expect(dec.decode(accepted[0]!.messages[0])).toBe('ping')

    accepted[0]!.raw.send('pong')
    await waitFor(() => events.messages.length === 1)
    expect(dec.decode(events.messages[0])).toBe('pong')
  })

  it('aborts the stream when authenticate throws (client 1006, no onConnection)', async () => {
    const { serverNode, accepted } = await listen(async () => {
      throw new Error('denied')
    })
    const clientNode = await makeNode(false)
    cleanups.push(() => clientNode.stop())
    const { events } = dial(serverNode, clientNode)
    await waitFor(() => events.closes.length === 1)
    expect(events.closes).toEqual([1006])
    expect(accepted).toHaveLength(0)
  })

  it('client close() -> server onClose(1000); server terminate() -> client onClose(1006)', async () => {
    const { serverNode, accepted } = await listen(ok)
    const clientNode = await makeNode(false)
    cleanups.push(() => clientNode.stop())

    const a = dial(serverNode, clientNode)
    await waitFor(() => a.events.opened && accepted.length === 1)
    a.raw.close()
    await waitFor(() => accepted[0]!.closes.length === 1)
    expect(accepted[0]!.closes).toEqual([1000])
    expect(a.events.closes).toEqual([1000])

    const b = dial(serverNode, clientNode)
    await waitFor(() => b.events.opened && accepted.length === 2)
    accepted[1]!.raw.terminate()
    await waitFor(() => b.events.closes.length === 1)
    expect(b.events.closes).toEqual([1006])
  })

  it('fires onClose(1006) when dialing an absent protocol/server', async () => {
    const serverNode = await makeNode(true) // no transport started -> protocol not handled
    const clientNode = await makeNode(false)
    cleanups.push(() => serverNode.stop())
    cleanups.push(() => clientNode.stop())
    const { events } = dial(serverNode, clientNode)
    await waitFor(() => events.closes.length === 1)
    expect(events.closes).toEqual([1006])
  })

  it('does not leak a zombie conn when the stream resets during authenticate', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const accepted: Accepted[] = []
    const serverNode = await makeNode(true)
    const transport = libp2pServerTransport({ node: serverNode })
    await transport.start({
      authenticate: async () => {
        await gate
        return { role: 'user', ctx: {} }
      },
      onConnection(raw, auth) {
        const rec: Accepted = { raw, auth, messages: [], closes: [] }
        raw.onClose((code) => rec.closes.push(code))
        accepted.push(rec)
      },
    })
    cleanups.push(() => transport.stop())
    cleanups.push(() => serverNode.stop())
    const clientNode = await makeNode(false)
    cleanups.push(() => clientNode.stop())

    const { raw } = dial(serverNode, clientNode)
    await tick(150) // frame 1 arrives; authenticate parks on the gate
    raw.terminate() // client aborts -> the server's stream resets WHILE authenticate is pending
    await tick(150) // let the reset reach the server stream
    release() // authenticate resolves -> onConnection wires wireClose on an already-reset stream
    await waitFor(() => accepted.length === 1 && accepted[0]!.closes.length === 1)
    expect(accepted[0]!.closes).toEqual([1006]) // self-heal fired onClose; no zombie
  })

  it('a throwing onMessage handler does not stop the read loop', async () => {
    const { serverNode, accepted } = await listen(ok)
    const clientNode = await makeNode(false)
    cleanups.push(() => clientNode.stop())
    const received: string[] = []
    libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() }).connect(
      { role: 'user' },
      {
        onOpen: () => {},
        onMessage: (b) => {
          const s = dec.decode(b)
          if (s === 'B') throw new Error('boom') // a buggy app handler
          received.push(s)
        },
        onClose: () => {},
        onDrain: () => {},
      },
    )
    await waitFor(() => accepted.length === 1)
    accepted[0]!.raw.send('A')
    accepted[0]!.raw.send('B')
    accepted[0]!.raw.send('C')
    await waitFor(() => received.length === 2)
    expect(received).toEqual(['A', 'C']) // B threw but the loop kept reading
  })
})
