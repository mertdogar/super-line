import type { WorkflowsOptions } from '../src/index.js'

export interface CrashCounters {
  countRows: number
  aggregate: number
}

// Shared by the crash-worker child and the resuming test process: deterministic replay requires
// both to register the exact same orchestration code.
export const crashDefinitions = (counters: CrashCounters): Omit<WorkflowsOptions, 'provider'> => ({
  activities: {
    countRows: async ({ n }: { n: number }) => {
      counters.countRows += 1
      return n * 10
    },
    aggregate: async ({ values }: { values: number[] }) => {
      counters.aggregate += 1
      return values.reduce((a, b) => a + b, 0)
    },
  },
  workflows: {
    reportPipeline: function* (ctx, input) {
      ctx.setCustomStatus('fanning-out')
      const counts = yield ctx.all([
        ctx.scheduleActivity('countRows', { n: 1 }),
        ctx.scheduleActivity('countRows', { n: 2 }),
      ])
      ctx.setCustomStatus('waiting-timer')
      yield ctx.scheduleTimer(6_000)
      ctx.setCustomStatus('aggregating')
      const values = (counts as { ok?: string }[]).map((c) => JSON.parse(c.ok!) as number)
      const total = yield ctx.scheduleActivity('aggregate', { values })
      return { total: JSON.parse(total as string), label: (input as { label: string }).label }
    },
  },
})
