import { afterEach, describe, expect, it } from 'vitest'
import { createSuperLineClient } from '@super-line/client'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { app } from '../src/contract.js'
import { dashboard } from '../src/dashboard-contract.js'
import { dashboardHandlers } from '../src/dashboard.js'
import { queueKit } from '../src/queue.js'

describe('queue dashboard requests', () => {
  let server: SuperLineServer<any, any> | undefined
  let closeClient: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeClient?.()
    await server?.close()
  })

  it('creates a job and lists only its dashboard-safe summary', async () => {
    const loopback = createLoopbackTransport()
    server = createSuperLineServer(app, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'dashboard' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [queueKit.plugin],
    })
    server.implement({ dashboard: dashboardHandlers })

    const client = createSuperLineClient(dashboard, {
      transport: loopback.client(),
      role: 'dashboard',
      validate: 'inbound',
    })
    closeClient = () => client.close()

    const created = await client.createReportJob({ reportId: 'quarterly-report' })
    expect(created.jobId).toEqual(expect.any(String))

    const jobs = await client.listJobs()
    expect(jobs[0]).toMatchObject({
      id: created.jobId,
      reportId: 'quarterly-report',
      source: 'web',
      status: expect.stringMatching(/queued|running|completed/),
    })
    expect(jobs[0]).not.toHaveProperty('input')
    expect(jobs[0]).not.toHaveProperty('leaseExpiresAt')
    expect(jobs[0]).not.toHaveProperty('nodeKey')
  })
})
