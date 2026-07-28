import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer, type SuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { PermanentJobError, QUEUE_JOBS, queue } from '../src/index.js'

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}

describe('queue kit', () => {
  let server: SuperLineServer<any, any> | undefined

  afterEach(async () => {
    await server?.close()
  })

  it('constructs once, mounts its contract and plugin, and executes a typed job', async () => {
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        uppercase: {
          input: z.object({ value: z.string() }),
          result: z.object({ value: z.string() }),
          concurrency: 1,
          worker: async ({ value }) => ({ value: value.toUpperCase() }),
        },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const queued = await kit.enqueue('uppercase', { value: 'hello' })
    const completed = await waitFor(() => kit.get(queued.id), (job) => job?.status === 'completed')

    expect(completed).toMatchObject({
      status: 'completed',
      attempt: 1,
      result: { value: 'HELLO' },
    })
  })

  it('retries ordinary errors and treats PermanentJobError as terminal', async () => {
    let attempts = 0
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        unstable: {
          input: z.string(),
          result: z.string(),
          concurrency: 1,
          retry: { maxAttempts: 3, backoff: { type: 'fixed', delayMs: 1, jitter: 0 } },
          worker: async (value) => {
            attempts++
            if (value === 'permanent') throw new PermanentJobError('no')
            if (attempts === 1) throw new Error('again')
            return value
          },
        },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const retried = await kit.enqueue('unstable', 'ok')
    expect(await waitFor(() => kit.get(retried.id), (job) => job?.status === 'completed')).toMatchObject({ attempt: 2 })

    const permanent = await kit.enqueue('unstable', 'permanent')
    expect(await waitFor(() => kit.get(permanent.id), (job) => job?.status === 'failed')).toMatchObject({ attempt: 1 })
  })

  it('persists schedules and turns an explicit trigger into an ordinary job', async () => {
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        report: {
          input: z.object({ accountId: z.string() }),
          result: z.object({ ok: z.boolean() }),
          concurrency: 1,
          worker: async () => ({ ok: true }),
        },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const schedule = await kit.schedules.create({
      id: 'daily-report',
      queue: 'report',
      cron: '0 9 * * *',
      timezone: 'Europe/Berlin',
      input: { accountId: 'a1' },
    })
    const job = await kit.schedules.trigger(schedule.id)

    expect(await kit.schedules.get(schedule.id)).toMatchObject({ cron: '0 9 * * *', timezone: 'Europe/Berlin' })
    expect(await waitFor(() => kit.get(job.id), (row) => row?.status === 'completed')).toMatchObject({
      scheduleId: 'daily-report',
      result: { ok: true },
    })
  })

  it('fences a timed-out worker and releases its declarative slot', async () => {
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        blocked: {
          input: z.string(),
          result: z.string(),
          concurrency: 1,
          timeoutMs: 20,
          retry: { maxAttempts: 1 },
          worker: async () => new Promise<string>(() => {}),
        },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const job = await kit.enqueue('blocked', 'work')
    expect(await waitFor(() => kit.get(job.id), (row) => row?.status === 'failed')).toMatchObject({
      attempt: 1,
      lastError: { message: 'Job aborted' },
    })
  })

  it('denies queue collections to ordinary clients', async () => {
    const kit = queue({
      queues: {
        hidden: {
          input: z.string(),
          result: z.string(),
          concurrency: 1,
          worker: async (value) => value,
        },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    const loopback = createLoopbackTransport()
    server = createSuperLineServer(contract, {
      transports: [loopback.server],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })
    const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
    const rows = client.collection(QUEUE_JOBS).subscribe({})

    await expect(rows.ready).rejects.toMatchObject({ code: 'FORBIDDEN' })
    client.close()
  })

  it('leaves an unbound queue queued rather than failing it, and drains it once a worker binds', async () => {
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        deferred: { input: z.string(), result: z.string(), concurrency: 1 },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const handle = kit.queue('deferred')
    expect(handle.hasWorker).toBe(false)

    const job = await kit.enqueue('deferred', 'work')
    await new Promise((resolve) => setTimeout(resolve, 100))
    // ~10 poll intervals later the job is untouched: no claim, no attempt, no failure
    expect(await kit.get(job.id)).toMatchObject({ status: 'queued', attempt: 0 })

    handle.setWorker(async (value) => value.toUpperCase())
    expect(handle.hasWorker).toBe(true)
    expect(await waitFor(() => kit.get(job.id), (row) => row?.status === 'completed')).toMatchObject({
      result: 'WORK',
    })
  })

  it('replaces an inline worker with one bound before the server is even constructed', async () => {
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        greet: { input: z.string(), result: z.string(), concurrency: 1, worker: async () => 'inline' },
      },
    })
    kit.queue('greet').setWorker(async () => 'bound')

    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const job = await kit.enqueue('greet', 'hi')
    expect(await waitFor(() => kit.get(job.id), (row) => row?.status === 'completed')).toMatchObject({
      result: 'bound',
    })
  })

  it('scopes a handle enqueue, list, and schedules to its own queue', async () => {
    const kit = queue({
      pollIntervalMs: 10,
      queues: {
        alpha: { input: z.string(), result: z.string(), concurrency: 1, worker: async (value) => value },
        beta: { input: z.string(), result: z.string(), concurrency: 1, worker: async (value) => value },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const alpha = kit.queue('alpha')
    await alpha.enqueue('one')
    await kit.queue('beta').enqueue('two')

    expect(await alpha.list()).toMatchObject([{ queue: 'alpha', input: 'one' }])
    expect(await kit.list()).toHaveLength(2)

    await alpha.schedules.create({ cron: '0 9 * * *', input: 'nightly' })
    expect(await alpha.schedules.list()).toMatchObject([{ queue: 'alpha', cron: '0 9 * * *' }])
    expect(await kit.queue('beta').schedules.list()).toEqual([])
  })

  it('does not reap a worker whose lease was renewed after an expiry scan', async () => {
    const kit = queue({
      pollIntervalMs: 5,
      queues: {
        heartbeat: {
          input: z.string(),
          result: z.string(),
          concurrency: 1,
          leaseMs: 300,
          worker: async (value) => {
            await new Promise((resolve) => setTimeout(resolve, 700))
            return value
          },
        },
      },
    })
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })

    const job = await kit.enqueue('heartbeat', 'alive')
    expect(await waitFor(() => kit.get(job.id), (row) => row?.status === 'completed')).toMatchObject({
      attempt: 1,
      result: 'alive',
    })
  })
})
