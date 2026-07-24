import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { configureSync, resetSync } from '@logtape/logtape'
import { createLogRecorder } from '@logtape/testing'
import { defineContract } from '@super-line/core'
import { createHarness, waitFor } from './harness.js'

// Proof that the getLogger() call sites actually emit STRUCTURED records end-to-end when an app configures
// LogTape — and stay silent otherwise (every other test in the suite runs with no config and no leakage).
const app = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.object({ ok: z.boolean() }) } } } },
})

const h = createHarness()
afterEach(() => {
  h.dispose()
  resetSync()
})

describe('super-line logging is wired and structured', () => {
  it('emits structured server/client diagnostics to a configured [super-line] sink', async () => {
    const recorder = createLogRecorder()
    configureSync({
      reset: true,
      sinks: { rec: recorder.sink },
      loggers: [
        { category: ['super-line'], lowestLevel: 'trace', sinks: ['rec'] },
        { category: ['logtape', 'meta'], sinks: [] },
      ],
    })

    const { srv, url } = await h.server(app, {
      nodeKey: 'log-test',
      authenticate: () => ({ role: 'user', ctx: { userId: 'u-1' } }),
    })
    srv.implement({ user: { ping: async () => ({ ok: true }) } } as never)

    const client = h.client(app, { url, role: 'user' })
    expect(await client.ping()).toEqual({ ok: true })
    await waitFor(() => recorder.records.some((r) => r.category.join('.') === 'super-line.server.dispatch'))

    // server logged a structured connection-accepted with real fields (not a stringified blob)
    const accepted = recorder.records.find((r) => r.category.at(-1) === 'conn' && r.category[1] === 'server')
    expect(accepted).toBeDefined()
    expect((accepted!.properties as Record<string, unknown>).role).toBe('user')

    // server logged the request dispatch at trace with the method name
    const dispatch = recorder.records.find((r) => r.category.join('.') === 'super-line.server.dispatch')
    expect((dispatch!.properties as Record<string, unknown>).name).toBe('ping')

    // client logged its own connect
    const clientConn = recorder.records.find((r) => r.category.join('.') === 'super-line.client.conn')
    expect(clientConn).toBeDefined()
    expect((clientConn!.properties as Record<string, unknown>).role).toBe('user')
  })
})
