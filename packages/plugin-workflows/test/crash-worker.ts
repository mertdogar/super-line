// The child half of the crash-resume test: seeds a workflow, announces when it is parked on the
// durable timer, then stays alive until the parent SIGKILLs it. Run via tsx, not collected by vitest.
import { PostgresProvider } from 'duroxide'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer } from '@super-line/server'
import { WORKFLOW_RUNS, workflows, type WorkflowRun } from '../src/index.js'
import { crashDefinitions } from './crash-definitions.js'

const [pgUrl, schema] = process.argv.slice(2)
if (!pgUrl || !schema) throw new Error('usage: crash-worker.ts <pgUrl> <schema>')

const provider = await PostgresProvider.connectWithSchema(pgUrl, schema)
const kit = workflows({ provider, pollIntervalMs: 100, ...crashDefinitions({ countRows: 0, aggregate: 0 }) })
const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
const server = createSuperLineServer(contract, {
  transports: [],
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  collections: memoryCollections(),
  plugins: [kit.plugin],
})

await kit.run('reportPipeline', 'wf-crash', { label: 'daily' })

const readRow = (): Promise<WorkflowRun | undefined> =>
  ((server as { collection(name: string): unknown }).collection(WORKFLOW_RUNS) as {
    read(id: string): Promise<WorkflowRun | undefined>
  }).read('wf-crash')

const probe = setInterval(async () => {
  const row = await readRow()
  if (row?.customStatus === 'waiting-timer') {
    clearInterval(probe)
    console.log('MID-TIMER')
    setInterval(() => {}, 1_000) // stay alive until SIGKILL
  }
}, 100)
