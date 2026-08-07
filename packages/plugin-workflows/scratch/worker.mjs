// SCRATCH — demo host process (seed/resume roles); not shipped, not a test.
// Mounts the real kit on a real super-line server with memory collections.
import { SqliteProvider } from 'duroxide'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { createSuperLineServer } from '@super-line/server'
import { WORKFLOW_RUNS, workflows } from '../dist/index.js'

const DB = process.env.DEMO_DB ?? '/tmp/sl-plugin-workflows-demo.db'

let emailAttempted = false

const provider = await SqliteProvider.open(DB)
const kit = workflows({
  provider,
  activities: {
    countRows: async ({ n }) => n * 10,
    aggregate: async ({ values }) => values.reduce((a, b) => a + b, 0),
  },
  workflows: {
    reportPipeline: function* (ctx, input) {
      ctx.setCustomStatus('fanning-out')
      const counts = yield ctx.all([
        ctx.scheduleActivity('countRows', { n: 1 }),
        ctx.scheduleActivity('countRows', { n: 2 }),
      ])
      ctx.setCustomStatus('waiting-timer')
      yield ctx.scheduleTimer(4_000)
      ctx.setCustomStatus('aggregating')
      const total = yield ctx.scheduleActivity('aggregate', { values: counts.map((c) => JSON.parse(c.ok)) })
      return { total, label: input.label }
    },
  },
  queues: {
    sendEmail: {
      worker: async (input, { signal }) => {
        if (!emailAttempted) {
          emailAttempted = true
          throw new Error('SMTP transient (first attempt always fails)')
        }
        if (signal.aborted) return 'aborted'
        return `sent:${input.to}`
      },
      maxAttempts: 3,
      timeoutMs: 10_000,
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
      output: r.output === undefined ? '' : JSON.stringify(r.output).slice(0, 40),
    })),
  )
}

let lastPrinted = ''
const watchTable = setInterval(async () => {
  const rows = await server.collection(WORKFLOW_RUNS).snapshot()
  const fingerprint = JSON.stringify(rows.map((r) => [r.id, r.status, r.customStatus]))
  if (fingerprint !== lastPrinted) {
    lastPrinted = fingerprint
    await printRuns('changed')
  }
}, 300)

const role = process.argv[2]

if (role === 'seed') {
  await kit.queue('sendEmail').enqueue({ to: 'mert@example.com' }, { id: 'job-email-1' })
  await kit.run('reportPipeline', 'wf-report-1', { label: 'daily' })
  console.log('[seed] both started; running until the driver kills me...')
}

if (role === 'resume') {
  // no explicit recover() call — the plugin's setup re-arms projection on boot
  const st = await kit.waitFor('wf-report-1', 30_000)
  console.log(`[resume] wf-report-1 → ${st.status} output=${st.output}`)
  await new Promise((r) => setTimeout(r, 1_000))
  await printRuns('final')
  console.log('\n[resume] wf-report-1 history (replayed, not re-executed):')
  console.log('  ' + (await kit.history('wf-report-1')).join('\n  '))
  clearInterval(watchTable)
  await server.close()
  process.exit(0)
}
