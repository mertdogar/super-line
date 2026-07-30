import { afterEach, describe, expect, inject, it } from 'vitest'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { inspector } from '@super-line/plugin-inspector'
import { awaitWatchers, connectInspector, createHarness, waitFor } from './harness.js'

// Docker is probed once for the whole lane in global-docker.ts.
const dockerAvailable = inject('dockerAvailable')

const contract = defineContract({
  roles: {
    user: {
      clientToServer: { join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) } },
    },
  },
})

const redisUrl = inject('redisUrl')

const h = createHarness()
afterEach(() => h.dispose())

async function node() {
  const n = await h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: createRedisAdapter(redisUrl),
    plugins: [inspector()],
  })
  n.srv.implement({ user: { join: async () => ({ ok: true }) } })
  return n
}

describe.skipIf(!dockerAvailable)('redis inspector events cross-process', () => {
  it('delivers a connect event from node B to an inspector on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const insp = await connectInspector(nodeA.url) // inspector on A
    await insp.subscribeEvents()
    // B publishes only once it has heard that A has a watcher; warm up until it does.
    const warm = h.client(contract, { url: nodeB.url, role: 'user' })
    await awaitWatchers(insp, () => warm.join({ room: 'warm' }))

    const u = h.client(contract, { url: nodeB.url, role: 'user' }) // conn on B
    await u.join({ room: 'x' })

    await waitFor(() => insp.events.some((e) => e.type === 'connect'), 10000)
    const connectEv = insp.events.find((e) => e.type === 'connect')
    expect(connectEv?.descriptor?.nodeId).toBe(nodeB.srv.nodeId) // event originated on B
    insp.close()
  })

  it('delivers message events (request/response) from node B to an inspector on node A', async () => {
    const nodeA = await node()
    const nodeB = await node()

    const insp = await connectInspector(nodeA.url) // inspector on A
    await insp.subscribeEvents()
    const warm = h.client(contract, { url: nodeB.url, role: 'user' })
    await awaitWatchers(insp, () => warm.join({ room: 'warm' }))

    const u = h.client(contract, { url: nodeB.url, role: 'user' }) // request handled on B
    await u.join({ room: 'x' }) // B emits msg.request/response; they must cross the bus to A

    // Matched on identity, not position: the warm-up's own events keep arriving after it settles.
    const isX = (e: { type: string; input?: unknown }): boolean =>
      e.type === 'msg.request' && (e.input as { room?: string } | undefined)?.room === 'x'
    await waitFor(() => insp.events.some(isX), 10000)
    expect(insp.events.find(isX)?.name).toBe('join')

    await waitFor(() => insp.events.some((e) => e.type === 'msg.response'), 10000)
    expect(insp.events.find((e) => e.type === 'msg.response')?.ok).toBe(true)
    insp.close()
  })
})
