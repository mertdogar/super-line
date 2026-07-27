import * as z from 'zod'
import { defineContract, defineSurface } from '@super-line/core'

export const jobSummarySchema = z.object({
  id: z.string(),
  reportId: z.string(),
  source: z.enum(['bootstrap', 'cron', 'web']),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  priority: z.number(),
  attempt: z.number(),
  maxAttempts: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  availableAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  processedBy: z.string().optional(),
  lastError: z
    .object({
      message: z.string(),
      code: z.string().optional(),
      attempt: z.number(),
      at: z.number(),
    })
    .optional(),
})

export const dashboardSurface = defineSurface({
  clientToServer: {
    createReportJob: {
      input: z.object({ reportId: z.string().trim().min(1).max(80) }),
      output: z.object({ jobId: z.string() }),
    },
    listJobs: {
      input: z.void(),
      output: z.array(jobSummarySchema),
    },
  },
})

export const dashboard = defineContract({
  roles: { dashboard: dashboardSurface },
})
