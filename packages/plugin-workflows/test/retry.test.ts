import { afterEach, describe, expect, it } from 'vitest'
import { configureSync, type LogRecord } from '@logtape/logtape'
import { SqliteProvider } from 'duroxide'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer, type ServerCollectionHandle, type SuperLineServer } from '@super-line/server'
import { PermanentJobError, WORKFLOW_RUNS, workflows, type WorkflowRun, type WorkflowsOptions } from '../src/index.js'
import { waitFor as poll } from '../../core/test/wait.js'

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, label?: string): Promise<T> => {
  let last!: T
  await poll(async () => done((last = await read())), { timeout: 15_000, label })
  return last
}

describe('queue retry semantics', () => {
  const servers: SuperLineServer<any, any>[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  const mount = (kit: ReturnType<typeof workflows>) => {
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    const server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: memoryCollections(),
      plugins: [kit.plugin],
    })
    servers.push(server)
    return server
  }

  const makeKit = async (definitions: Omit<WorkflowsOptions, 'provider'>) =>
    workflows({ provider: await SqliteProvider.inMemory(), pollIntervalMs: 25, shutdownGraceMs: 500, ...definitions })

  const runRow = (server: { collection(name: string): unknown }, id: string): Promise<WorkflowRun | undefined> =>
    (server.collection(WORKFLOW_RUNS) as ServerCollectionHandle<WorkflowRun>).read(id)

  it('retries transient errors through the engine', async () => {
    let attempts = 0
    const kit = await makeKit({
      queues: {
        flaky: {
          worker: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('transient')
            return 'ok'
          },
          maxAttempts: 3,
          timeoutMs: 10_000,
        },
      },
    })
    const server = mount(kit)

    await kit.queue('flaky').enqueue({}, { id: 'job-flaky' })
    const row = await waitFor(() => runRow(server, 'job-flaky'), (r) => r?.status === 'completed', 'flaky completes')

    expect(attempts).toBe(2)
    expect(row!.output).toBe('ok')
  })

  it('PermanentJobError fails immediately with the reason on the row — no retries', async () => {
    let classAttempts = 0
    let duckAttempts = 0
    const kit = await makeKit({
      queues: {
        exported: {
          worker: async () => {
            classAttempts += 1
            throw new PermanentJobError('no such user', 'NO_USER')
          },
          maxAttempts: 3,
          timeoutMs: 10_000,
        },
        ducked: {
          worker: async () => {
            duckAttempts += 1
            const error = new Error('bad payload')
            error.name = 'PermanentJobError'
            throw error
          },
          maxAttempts: 3,
          timeoutMs: 10_000,
        },
      },
    })
    const server = mount(kit)

    await kit.queue('exported').enqueue({}, { id: 'job-exported' })
    await kit.queue('ducked').enqueue({}, { id: 'job-ducked' })
    const exported = await waitFor(() => runRow(server, 'job-exported'), (r) => r?.status === 'failed', 'exported fails')
    const ducked = await waitFor(() => runRow(server, 'job-ducked'), (r) => r?.status === 'failed', 'ducked fails')

    expect(classAttempts).toBe(1)
    expect(duckAttempts).toBe(1)
    expect(exported!.error).toBe('no such user')
    expect(ducked!.error).toBe('bad payload')
  })

  it('bridges engine tracing into the super-line LogTape tree', async () => {
    const records: LogRecord[] = []
    configureSync({
      reset: true,
      sinks: { capture: (record) => records.push(record) },
      loggers: [{ category: ['super-line', 'plugin-workflows'], lowestLevel: 'debug', sinks: ['capture'] }],
    })

    const kit = await makeKit({
      activities: { echo: async ({ value }: { value: string }) => value },
      workflows: {
        ping: function* (ctx, input) {
          return yield ctx.scheduleActivity('echo', input)
        },
      },
    })
    const server = mount(kit)
    await kit.run('ping', 'wf-ping', { value: 'hello' })
    await waitFor(() => runRow(server, 'wf-ping'), (r) => r?.status === 'completed', 'ping completes')

    const engineRecords = await waitFor(
      async () => records.filter((r) => r.category.join('.') === 'super-line.plugin-workflows.engine'),
      (found) => found.length > 0,
      'engine records bridged',
    )
    expect(engineRecords[0]!.message.join('')).not.toHaveLength(0)
  })
})
