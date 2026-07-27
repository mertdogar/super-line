import type { QueueJob } from '@super-line/plugin-queue'
import { queueKit } from './queue.js'

type ReportInput = {
  reportId: string
  source: 'bootstrap' | 'cron' | 'web'
}

const reportInput = (job: QueueJob): ReportInput => job.input as ReportInput

const processedBy = (job: QueueJob): string | undefined => {
  if (!job.result || typeof job.result !== 'object') return undefined
  const value = (job.result as Record<string, unknown>).processedBy
  return typeof value === 'string' ? value : undefined
}

const summarize = (job: QueueJob) => ({
  id: job.id,
  reportId: reportInput(job).reportId,
  source: reportInput(job).source,
  status: job.status,
  priority: job.priority,
  attempt: job.attempt,
  maxAttempts: job.maxAttempts,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  availableAt: job.availableAt,
  ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
  ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
  ...(processedBy(job) === undefined ? {} : { processedBy: processedBy(job) }),
  ...(job.lastError === undefined
    ? {}
    : {
        lastError: {
          message: job.lastError.message,
          ...(job.lastError.code === undefined ? {} : { code: job.lastError.code }),
          attempt: job.lastError.attempt,
          at: job.lastError.at,
        },
      }),
})

export const dashboardHandlers = {
  createReportJob: async ({ reportId }: { reportId: string }) => {
    const job = await queueKit.enqueue('report', { reportId, source: 'web' })
    return { jobId: job.id }
  },
  listJobs: async () => {
    const jobs = await queueKit.list({
      orderBy: [{ field: 'createdAt', dir: 'desc' }],
      limit: 50,
    })
    return jobs.map(summarize)
  },
}
