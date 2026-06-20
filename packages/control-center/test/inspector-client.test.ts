import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createInspector, type InspectorClient } from '../src/lib/inspector-client.js'

const contract = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function startServer() {
  const httpServer = http.createServer()
  const srv = createSuperLineServer(contract, {
    server: httpServer,
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    inspector: true,
  })
  srv.implement({ user: { ping: async () => 1 } })
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const { port } = httpServer.address() as AddressInfo
  cleanups.push(async () => {
    await srv.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  })
  return { srv, url: `ws://127.0.0.1:${port}` }
}

function whenOpen(insp: InspectorClient): Promise<void> {
  return new Promise((resolve) => {
    const off = insp.onStatus((s) => {
      if (s === 'open') {
        off()
        resolve()
      }
    })
  })
}

async function waitFor(pred: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('inspector client', () => {
  it('connects and queries topology / connections / contract', async () => {
    const { srv, url } = await startServer()
    const user = createSuperLineClient(contract, { url, role: 'user' })
    cleanups.push(() => user.close())
    await user.ping() // a node only appears in topology once it holds a connection

    const insp = createInspector({ url, reconnect: false })
    cleanups.push(() => insp.close())
    await whenOpen(insp)

    const topology = await insp.getTopology()
    expect(topology).toHaveLength(1)
    expect(topology[0]?.nodeId).toBe(srv.nodeId)
    expect(topology[0]?.connections).toBe(1) // the inspector itself is not counted

    const conns = await insp.listConnections()
    expect(conns).toHaveLength(1)
    expect(conns[0]?.role).toBe('user')

    const contractView = await insp.getContract()
    expect(Object.keys(contractView.roles)).toContain('user')
  })

  it('receives live connect events', async () => {
    const { url } = await startServer()
    const insp = createInspector({ url, reconnect: false })
    cleanups.push(() => insp.close())
    await whenOpen(insp)
    await insp.getNode() // flush: ensures the events subscribe frame was processed first (in-order)

    const types: string[] = []
    insp.onEvent((e) => types.push(e.type))

    const user = createSuperLineClient(contract, { url, role: 'user' })
    cleanups.push(() => user.close())
    await user.ping()

    await waitFor(() => types.includes('connect'))
    expect(types).toContain('connect')
  })
})
