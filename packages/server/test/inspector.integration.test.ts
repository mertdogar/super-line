import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { defineContract, jsonSerializer, INSPECTOR_SUBPROTOCOL } from '@super-line/core'
import type { InspectedContract, Schema } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'

const contract = defineContract({
  roles: {
    user: { clientToServer: { ping: { input: z.void(), output: z.number() } } },
    agent: {},
  },
})

function authenticate(req: { url?: string }) {
  const role = new URL(req.url ?? '', 'http://localhost').searchParams.get('role') as 'user' | 'agent'
  return { role, ctx: { role } }
}

interface Inspector {
  protocol: string
  request: (m: string, d?: unknown) => Promise<unknown>
  close: () => void
}

// A minimal raw-ws inspector client (the typed client is slice 6): connects with the reserved
// subprotocol, sends `req` frames, and resolves on the matching `res`/`err`.
function connectInspector(url: string): Promise<Inspector> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    let id = 1
    const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
    ws.on('message', (data) => {
      const frame = jsonSerializer.decode(data as Buffer) as {
        t: string
        i: number
        d?: unknown
        code?: string
      }
      const w = waiters.get(frame.i)
      if (!w) return
      waiters.delete(frame.i)
      if (frame.t === 'res') w.resolve(frame.d)
      else if (frame.t === 'err') w.reject(new Error(frame.code))
    })
    ws.on('open', () =>
      resolve({
        protocol: ws.protocol,
        request: (m, d) =>
          new Promise((res, rej) => {
            const i = id++
            waiters.set(i, { resolve: res, reject: rej })
            ws.send(jsonSerializer.encode({ t: 'req', i, m, d }))
          }),
        close: () => ws.close(),
      }),
    )
    ws.on('error', reject)
  })
}

const h = createHarness()
afterEach(() => h.dispose())

describe('inspector connection (slice 2)', () => {
  it('echoes the reserved subprotocol and bypasses authenticate', async () => {
    let authCalls = 0
    const { url } = await h.server(contract, {
      authenticate: (req) => {
        authCalls++
        return authenticate(req)
      },
      inspector: true,
    })
    const insp = await connectInspector(url)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    expect(authCalls).toBe(0)
    insp.close()
  })

  it('serves getNode / listConnections / getTopology, excluding itself', async () => {
    const { srv, url } = await h.server(contract, { authenticate, inspector: true })
    srv.implement({ user: { ping: async () => 1 }, agent: {} })

    const u1 = h.client(contract, { url, role: 'user' })
    const u2 = h.client(contract, { url, role: 'user' })
    await Promise.all([u1.ping(), u2.ping()])
    await waitFor(() => srv.local.connections.length === 2)

    const insp = await connectInspector(url)

    const node = (await insp.request('getNode')) as { nodeId: string; rooms: string[]; topics: string[] }
    expect(node.nodeId).toBe(srv.nodeId)
    expect(node.rooms).toEqual([])
    expect(node.topics).toEqual([])

    const conns = (await insp.request('listConnections')) as Array<{ role: string }>
    expect(conns).toHaveLength(2) // the inspector itself is excluded from presence
    expect(conns.every((cn) => cn.role === 'user')).toBe(true)

    const topo = (await insp.request('getTopology')) as Array<{ nodeId: string; connections: number }>
    expect(topo).toHaveLength(1)
    expect(topo[0]?.nodeId).toBe(srv.nodeId)
    expect(topo[0]?.connections).toBe(2) // inspector not counted

    // observer-invisible in the server's own local view too
    expect(srv.local.connections).toHaveLength(2)

    insp.close()
  })

  it('returns NOT_FOUND for an unknown inspector method', async () => {
    const { url } = await h.server(contract, { authenticate, inspector: true })
    const insp = await connectInspector(url)
    await expect(insp.request('bogus')).rejects.toThrow('NOT_FOUND')
    insp.close()
  })

  it('rejects the inspector handshake when disabled', async () => {
    const { url } = await h.server(contract, { authenticate }) // inspector off
    // the server doesn't echo the reserved subprotocol, so the ws client fails the handshake
    await expect(connectInspector(url)).rejects.toThrow(/subprotocol/i)
  })
})

// a Standard Schema with an unknown vendor: no converter exists -> structure-only for that message
const mystery = {
  '~standard': { version: 1, vendor: 'mystery', validate: (value: unknown) => ({ value }) },
} as unknown as Schema

const richContract = defineContract({
  roles: {
    user: {
      clientToServer: {
        say: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
        raw: { input: mystery, output: mystery },
      },
      serverToClient: {
        feed: { payload: z.object({ n: z.number() }), subscribe: true },
      },
    },
  },
})

describe('inspector getContract (slice 3)', () => {
  it('returns structure + best-effort JSON Schema, falling back to structure-only per message', async () => {
    const { url } = await h.server(richContract, {
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      inspector: true,
    })
    const insp = await connectInspector(url)
    const got = (await insp.request('getContract')) as InspectedContract

    const cts = got.roles.user?.clientToServer ?? []
    const say = cts.find((m) => m.name === 'say')
    expect(say?.flavor).toBe('request')
    const sayInput = say?.input as { type?: string; properties?: Record<string, unknown> } | undefined
    expect(sayInput?.type).toBe('object') // zod -> JSON Schema
    expect(sayInput?.properties?.text).toBeDefined()
    expect(say?.output).toMatchObject({ type: 'object' })

    const raw = cts.find((m) => m.name === 'raw')
    expect(raw?.flavor).toBe('request')
    expect(raw?.input).toBeUndefined() // unknown vendor -> structure only
    expect(raw?.output).toBeUndefined()

    const feed = (got.roles.user?.serverToClient ?? []).find((m) => m.name === 'feed')
    expect(feed?.flavor).toBe('topic')
    expect(feed?.payload).toMatchObject({ type: 'object' })

    insp.close()
  })
})
