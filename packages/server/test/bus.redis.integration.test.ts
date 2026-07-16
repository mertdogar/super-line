import { execSync } from 'node:child_process'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createRedisAdapter } from '@super-line/adapter-redis'
import { createHarness, tick } from './harness.js'

// Requires Docker (the shared per-run redis:7 from global-docker.ts); skipped cleanly when Docker is absent.
let dockerAvailable = true
try {
  execSync('docker info', { stdio: 'ignore' })
} catch {
  dockerAvailable = false
}

const contract = defineContract({
  shared: {
    serverToClient: {
      announce: { payload: z.object({ msg: z.string() }), subscribe: true },
    },
  },
  roles: { user: {} },
})

const redisUrl = inject('redisUrl')

const h = createHarness()
afterEach(() => h.dispose())

function node() {
  return h.server(contract, {
    authenticate: () => ({ role: 'user' as const, ctx: {} }),
    adapter: createRedisAdapter(redisUrl),
  })
}

describe.skipIf(!dockerAvailable)('cluster event bus over redis', () => {
  it('fires same-node subscribers synchronously at publish time — no Redis round-trip', async () => {
    const a = await node()

    let fired = 0
    let metaFrom = ''
    a.srv.subscribe('announce', (_d, m) => {
      fired++
      metaFrom = m.from
    })

    a.srv.publish('announce', { msg: 'local' })

    // No await between publish and this assertion. The Redis loopback is async AND is deduped
    // (frame.i === instanceId), so the ONLY way this already fired is the in-process direct path.
    expect(fired).toBe(1)
    expect(metaFrom).toBe(a.srv.nodeId)

    // the looped-back copy may arrive over Redis later, but it's dropped — still exactly one.
    await tick(200)
    expect(fired).toBe(1)
  })

  it('delivers a publish from node B to a server subscriber on node A, tagged with B', async () => {
    const a = await node()
    const b = await node()

    const got: Array<{ msg: string; from: string }> = []
    a.srv.subscribe('announce', (d, m) => got.push({ msg: d.msg, from: m.from }))

    // server.subscribe -> adapter.subscribe is fire-and-forget (no ack); retry the publish until
    // the Redis SUBSCRIBE has propagated (a non-issue in real apps where the two aren't co-timed).
    for (let i = 0; i < 50 && got.length === 0; i++) {
      b.srv.publish('announce', { msg: 'from-b' })
      await tick(100)
    }

    expect(got[0]).toEqual({ msg: 'from-b', from: b.srv.nodeId })
  })
})
