import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteProvider } from 'duroxide'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { sqliteCollections } from '@super-line/collections-sqlite'
import { createSuperLineServer, type ServerCollectionHandle, type SuperLineServer } from '@super-line/server'
import { WORKFLOW_RUNS, workflows, type WorkflowRun, type WorkflowsOptions } from '../src/index.js'
import { waitFor as poll } from '../../core/test/wait.js'

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, label?: string): Promise<T> => {
  let last!: T
  await poll(async () => done((last = await read())), { timeout: 10_000, label })
  return last
}

describe('workflow lifecycle projection', () => {
  const servers: SuperLineServer<any, any>[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const tmpDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-workflows-'))
    dirs.push(dir)
    return dir
  }

  const mount = (kit: ReturnType<typeof workflows>, collections = memoryCollections()) => {
    const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
    const server = createSuperLineServer(contract, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections,
      plugins: [kit.plugin],
    })
    servers.push(server)
    return server
  }

  const makeKit = async (definitions: Omit<WorkflowsOptions, 'provider'>) =>
    workflows({ provider: await SqliteProvider.inMemory(), pollIntervalMs: 25, shutdownGraceMs: 500, ...definitions })

  const runRow = (server: { collection(name: string): unknown }, id: string): Promise<WorkflowRun | undefined> =>
    (server.collection(WORKFLOW_RUNS) as ServerCollectionHandle<WorkflowRun>).read(id)

  it('never projects the transient notfound state while a run starts', async () => {
    const kit = await makeKit({
      workflows: {
        greet: function* (ctx, input) {
          return yield ctx.scheduleActivity('shout', input)
        },
      },
      activities: { shout: async ({ word }) => `${word}!` },
    })
    const server = mount(kit)

    await kit.run('greet', 'wf-1', { word: 'hi' })
    const seen = new Set<string>()
    await poll(
      async () => {
        const row = await runRow(server, 'wf-1')
        if (row) seen.add(row.status)
        return row?.status === 'completed'
      },
      { timeout: 10_000, label: 'wf-1 completes' },
    )
    expect(seen.has('notfound')).toBe(false)
    expect(seen.has('completed')).toBe(true)
  })

  it('normalizes rows: lowercase status, parsed output, customStatus cleared at terminal', async () => {
    const kit = await makeKit({
      workflows: {
        report: function* (ctx) {
          ctx.setCustomStatus('working')
          const total = yield ctx.scheduleActivity('sum', { values: [1, 2] })
          return { total: JSON.parse(total as string) }
        },
      },
      activities: { sum: async ({ values }) => values.reduce((a: number, b: number) => a + b, 0) },
    })
    const server = mount(kit)

    await kit.run('report', 'wf-report', {})
    const row = await waitFor(() => runRow(server, 'wf-report'), (r) => r?.status === 'completed', 'report row terminal')

    expect(row).toMatchObject({ status: 'completed', output: { total: 3 } })
    expect(row!.customStatus).toBeUndefined()
  })

  it('classifies engine cancellation as cancelled and preserves the reason', async () => {
    const kit = await makeKit({
      queues: {
        crunch: {
          worker: async (_input, { signal }) => {
            for (let i = 0; i < 200; i++) {
              if (signal.aborted) return 'aborted'
              await new Promise((r) => setTimeout(r, 50))
            }
            return 'finished'
          },
          maxAttempts: 1,
          timeoutMs: 60_000,
        },
      },
    })
    const server = mount(kit)

    await kit.queue('crunch').enqueue({ size: 'huge' }, { id: 'job-1' })
    await waitFor(() => runRow(server, 'job-1'), (r) => r?.status === 'running', 'job-1 running')
    await kit.cancel('job-1', 'user clicked stop')
    const row = await waitFor(() => runRow(server, 'job-1'), (r) => r?.status === 'cancelled', 'job-1 cancelled')

    expect(row).toMatchObject({ status: 'cancelled', kind: 'job', name: 'crunch', error: 'user clicked stop' })
  })

  it('recovers run metadata from the durable collection across a server restart', async () => {
    const provider = await SqliteProvider.inMemory()
    const file = join(tmpDir(), 'runs.db')
    const definitions: Omit<WorkflowsOptions, 'provider'> = {
      workflows: {
        approval: function* (ctx, input) {
          ctx.setCustomStatus('awaiting-approval')
          const decision = yield ctx.dequeueEvent('approvals')
          return { doc: input.doc, decision: JSON.parse(decision as string) }
        },
      },
    }

    const kitA = workflows({ provider, pollIntervalMs: 25, shutdownGraceMs: 500, ...definitions })
    const contractA = defineContract({ roles: { user: {} }, plugins: [kitA.contract] })
    const serverA = createSuperLineServer(contractA, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: sqliteCollections({ file, collections: contractA.collections! }),
      plugins: [kitA.plugin],
    })
    servers.push(serverA)

    await kitA.run('approval', 'wf-approve', { doc: 'Q3' })
    const parked = await waitFor(
      () => runRow(serverA, 'wf-approve'),
      (r) => r?.status === 'running' && r?.customStatus === 'awaiting-approval',
      'wf-approve parked',
    )
    await serverA.close()
    servers.splice(servers.indexOf(serverA), 1)

    const kitB = workflows({ provider, pollIntervalMs: 25, shutdownGraceMs: 500, ...definitions })
    const contractB = defineContract({ roles: { user: {} }, plugins: [kitB.contract] })
    const serverB = createSuperLineServer(contractB, {
      transports: [],
      authenticate: () => ({ role: 'user' as const, ctx: {} }),
      collections: sqliteCollections({ file, collections: contractB.collections! }),
      plugins: [kitB.plugin],
    })
    servers.push(serverB)

    await kitB.signal('wf-approve', 'approvals', { by: 'mert', ok: true })
    const row = await waitFor(() => runRow(serverB, 'wf-approve'), (r) => r?.status === 'completed', 'wf-approve completed')

    expect(row).toMatchObject({
      kind: 'workflow',
      name: 'approval',
      output: { doc: 'Q3', decision: { by: 'mert', ok: true } },
    })
    expect(row!.createdAt).toBe(parked!.createdAt)
    expect(row!.customStatus).toBeUndefined()
  })
})
