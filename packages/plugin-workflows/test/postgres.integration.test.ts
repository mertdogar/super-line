import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers'
import { PostgresProvider } from 'duroxide'
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer, type ServerCollectionHandle, type SuperLineServer } from '@super-line/server'
import { PermanentJobError, WORKFLOW_RUNS, workflows, type WorkflowRun, type WorkflowsOptions } from '../src/index.js'
import { waitForWith } from '../../core/test/wait.js'
import { crashDefinitions, type CrashCounters } from './crash-definitions.js'

const waitFor = waitForWith(15_000)

// Docker is probed once for the whole lane in global-docker.ts.
const dockerAvailable = inject('dockerAvailable')

const here = dirname(fileURLToPath(import.meta.url))

let pg: StartedTestContainer
let pgUrl: string

beforeAll(async () => {
  if (!dockerAvailable) return
  pg = await new GenericContainer('postgres:16')
    .withEnvironment({ POSTGRES_DB: 'duroxide', POSTGRES_USER: 'postgres', POSTGRES_PASSWORD: 'password' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start()
  pgUrl = `postgres://postgres:password@${pg.getHost()}:${pg.getMappedPort(5432)}/duroxide`
}, 240_000)

afterAll(async () => {
  await pg?.stop()
})

describe.skipIf(!dockerAvailable)('plugin-workflows over real Postgres', () => {
  const servers: SuperLineServer<any, any>[] = []
  let child: ChildProcess | undefined

  afterEach(async () => {
    child?.kill('SIGKILL')
    child = undefined
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

  const makeKit = async (schema: string, definitions: Omit<WorkflowsOptions, 'provider'>) => {
    const provider = await PostgresProvider.connectWithSchema(pgUrl, schema)
    return workflows({ provider, pollIntervalMs: 100, shutdownGraceMs: 500, ...definitions })
  }

  const runRow = (server: { collection(name: string): unknown }, id: string): Promise<WorkflowRun | undefined> =>
    (server.collection(WORKFLOW_RUNS) as ServerCollectionHandle<WorkflowRun>).read(id)

  const waitRow = async (
    server: { collection(name: string): unknown },
    id: string,
    done: (row: WorkflowRun | undefined) => boolean,
    label: string,
  ): Promise<WorkflowRun | undefined> => {
    let last: WorkflowRun | undefined
    await waitFor(async () => done((last = await runRow(server, id))), { label })
    return last
  }

  it('resumes a SIGKILLed process: completed activities replay, only the rest execute', async () => {
    const schema = 'slwf_crash'
    // node directly with the tsx loader, NOT the `tsx` bin: that bin is a launcher around a node child, so
    // SIGKILLing it orphans the real worker, which then races this process for the post-timer step.
    child = spawn(process.execPath, ['--import', 'tsx', join(here, 'crash-worker.ts'), pgUrl, schema], {
      cwd: join(here, '..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('crash worker never reached MID-TIMER')), 60_000)
      child!.stdout!.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('MID-TIMER')) {
          clearTimeout(deadline)
          resolve()
        }
      })
      child!.on('exit', (code) => {
        clearTimeout(deadline)
        reject(new Error(`crash worker exited early (code ${code})`))
      })
    })
    child.removeAllListeners('exit')
    child.kill('SIGKILL') // the crash: no graceful shutdown, mid-durable-timer

    const counters: CrashCounters = { countRows: 0, aggregate: 0 }
    const kit = await makeKit(schema, crashDefinitions(counters))
    const server = mount(kit)

    const row = await waitRow(server, 'wf-crash', (r) => r?.status === 'completed', 'crashed run resumes')

    expect(row).toMatchObject({ kind: 'workflow', name: 'reportPipeline', output: { total: 30, label: 'daily' } })
    expect(counters.countRows).toBe(0) // the fan-out replayed from checkpoints — never re-executed here
    expect(counters.aggregate).toBe(1) // only the step after the timer ran in this process
  })

  it('classifies cancellation and permanent failure', async () => {
    let doomedAttempts = 0
    const kit = await makeKit('slwf_jobs', {
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
        doomed: {
          worker: async () => {
            doomedAttempts += 1
            throw new PermanentJobError('no such user', 'NO_USER')
          },
          maxAttempts: 3,
          timeoutMs: 10_000,
        },
      },
    })
    const server = mount(kit)

    await kit.queue('crunch').enqueue({}, { id: 'job-crunch' })
    await waitRow(server, 'job-crunch', (r) => r?.status === 'running', 'crunch running')
    await kit.cancel('job-crunch', 'user clicked stop')
    const cancelled = await waitRow(server, 'job-crunch', (r) => r?.status === 'cancelled', 'crunch cancelled')

    await kit.queue('doomed').enqueue({}, { id: 'job-doomed' })
    const failed = await waitRow(server, 'job-doomed', (r) => r?.status === 'failed', 'doomed failed')

    expect(cancelled).toMatchObject({ status: 'cancelled', error: 'user clicked stop' })
    expect(failed).toMatchObject({ status: 'failed', error: 'no such user' })
    expect(doomedAttempts).toBe(1)
  })

  it('parks on a durable signal and resumes with the payload', async () => {
    const kit = await makeKit('slwf_signal', {
      workflows: {
        approval: function* (ctx, input) {
          ctx.setCustomStatus('awaiting-approval')
          const decision = yield ctx.dequeueEvent('approvals')
          return { doc: (input as { doc: string }).doc, decision: JSON.parse(decision as string) }
        },
      },
    })
    const server = mount(kit)

    await kit.run('approval', 'wf-approve', { doc: 'Q3' })
    await waitRow(server, 'wf-approve', (r) => r?.customStatus === 'awaiting-approval', 'approval parked')
    await kit.signal('wf-approve', 'approvals', { by: 'mert', ok: true })
    const row = await waitRow(server, 'wf-approve', (r) => r?.status === 'completed', 'approval completed')

    expect(row!.output).toEqual({ doc: 'Q3', decision: { by: 'mert', ok: true } })
  })
})
