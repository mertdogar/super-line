import { afterEach, describe, expect, it } from 'vitest'
import { createLibp2p, type Libp2p } from 'libp2p'
import { memory } from '@libp2p/memory'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { libp2pServerTransport, libp2pClientTransport } from '../src/index.js'

// Proves the CORE works over a libp2p protocol stream — the interface proof for Step 3.
const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) },
      },
      serverToClient: {
        tick: { payload: z.object({ n: z.number() }) },
        feed: { payload: z.object({ v: z.number() }), subscribe: true },
      },
    },
  },
})

let memSeq = 0
async function makeNode(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: [`/memory/sl-tx-${++memSeq}`] } : {},
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

async function boot(serverOpts: { heartbeat?: { interval?: number } } = {}) {
  const serverNode = await makeNode(true)
  const clientNode = await makeNode(false)
  const srv = createSuperLineServer(contract, {
    transports: [libp2pServerTransport({ node: serverNode })],
    authenticate: (h) => ({ role: 'user' as const, ctx: { name: h.query.name ?? 'anon' } }),
    ...serverOpts,
  })
  const client = createSuperLineClient(contract, {
    transport: libp2pClientTransport({ node: clientNode, multiaddr: serverNode.getMultiaddrs() }),
    role: 'user',
    params: { name: 'alice' },
  })
  cleanups.unshift(() => client.close())
  cleanups.push(() => srv.close())
  cleanups.push(() => clientNode.stop())
  cleanups.push(() => serverNode.stop())
  return { srv, client }
}

describe('super-line over the libp2p transport', () => {
  it('round-trips a typed request', async () => {
    const { srv, client } = await boot()
    srv.implement({ user: { echo: async ({ text }) => ({ text: text.toUpperCase() }) } })
    const out = await client.echo({ text: 'hi' })
    expect(out).toEqual({ text: 'HI' })
  })

  it('passes handshake params through authenticate (via the first frame)', async () => {
    const { srv, client } = await boot()
    let seenName: string | undefined
    srv.implement({
      user: {
        echo: async ({ text }, ctx) => {
          seenName = (ctx as { name: string }).name
          return { text }
        },
      },
    })
    await client.echo({ text: 'x' })
    expect(seenName).toBe('alice')
  })

  it('pushes a server event to the connection', async () => {
    const { srv, client } = await boot()
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    const got: number[] = []
    client.on('tick', (d) => got.push(d.n))
    await client.echo({ text: 'connect' })
    srv.local.connections[0]!.emit('tick', { n: 7 })
    await waitFor(() => got.length === 1)
    expect(got).toEqual([7])
  })

  it('subscribes to a topic and receives a publish', async () => {
    const { srv, client } = await boot()
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    const got: number[] = []
    const sub = client.subscribe('feed', (d) => got.push(d.v))
    await sub.ready
    srv.forRole('user').publish('feed', { v: 42 })
    await waitFor(() => got.length === 1)
    expect(got).toEqual([42])
  })

  it('answers heartbeat pings so the server records liveness', async () => {
    const { srv, client } = await boot({ heartbeat: { interval: 25 } })
    srv.implement({ user: { echo: async ({ text }) => ({ text }) } })
    await client.echo({ text: 'connect' })
    const conn = srv.local.connections[0]!
    await waitFor(() => conn.lastPongAt !== undefined)
    expect(conn.lastPongAt).toBeGreaterThanOrEqual(conn.connectedAt)
  })
})
