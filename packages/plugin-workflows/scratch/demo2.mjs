// SCRATCH — cancellation + durable-signal demo: `node scratch/demo2.mjs`.
// A: a long-running job whose worker honors the AbortSignal shim; cancelled mid-flight.
// B: a workflow parked on a durable event queue; the host signals approval.
import { SqliteProvider } from 'duroxide'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer } from '@super-line/server'
import { WORKFLOW_RUNS, workflows } from '../dist/index.js'

const provider = await SqliteProvider.inMemory()
const kit = workflows({
  provider,
  workflows: {
    approval: function* (ctx, input) {
      ctx.setCustomStatus('awaiting-approval')
      const decision = yield ctx.dequeueEvent('approvals')
      ctx.setCustomStatus('approved')
      return { doc: input.doc, decision: JSON.parse(decision) }
    },
  },
  queues: {
    crunch: {
      worker: async (_input, { signal }) => {
        for (let i = 0; i < 100; i++) {
          if (signal.aborted) return 'aborted-cleanly-by-worker'
          await new Promise((r) => setTimeout(r, 200))
        }
        return 'finished (should not happen in this demo)'
      },
      maxAttempts: 1,
      timeoutMs: 60_000,
    },
  },
})

const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
const server = createSuperLineServer(contract, {
  transports: [],
  authenticate: () => ({ role: 'user', ctx: {} }),
  collections: memoryCollections(),
  plugins: [kit.plugin],
})

const printRuns = async (label) => {
  const rows = await server.collection(WORKFLOW_RUNS).snapshot()
  console.log(`\n[workflowRuns] ${label}`)
  console.table(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      status: r.status,
      custom: r.customStatus ?? '',
      output: r.output === undefined ? '' : String(r.output).slice(0, 60),
    })),
  )
}

console.log('════ A: cancellation mid-flight ════')
await kit.queue('crunch').enqueue({ size: 'huge' }, { id: 'job-crunch-1' })
await new Promise((r) => setTimeout(r, 1_200))
console.log('[host] cancelling job-crunch-1...')
await kit.cancel('job-crunch-1', 'user clicked stop')
await new Promise((r) => setTimeout(r, 2_000))
await printRuns('after cancel')

console.log('\n════ B: durable signal (approval) ════')
await kit.run('approval', 'wf-approve-1', { doc: 'Q3-report' })
await new Promise((r) => setTimeout(r, 1_200))
console.log('[host] signalling approval...')
await kit.signal('wf-approve-1', 'approvals', { by: 'mert', ok: true })
const st = await kit.waitFor('wf-approve-1', 15_000)
console.log(`[host] wf-approve-1 → ${st.status}`)
await new Promise((r) => setTimeout(r, 1_000))
await printRuns('final')

await server.close()
process.exit(0)
