import type { InspectedContract } from '@super-line/core'

export const QUEUE_PLUGIN = 'queue'
export const QUEUE_JOBS_COLLECTION = 'queueJobs'
export const QUEUE_SCHEDULES_COLLECTION = 'queueSchedules'

/**
 * Whether this server has the queue plugin active.
 * Both the runtime component and the expected collections must be present.
 */
export function queueLensActive(contract: InspectedContract | null): boolean {
  const queue = contract?.plugins?.find((p) => p.name === QUEUE_PLUGIN)
  return !!queue?.runtime && !!queue.contract?.collections.includes(QUEUE_JOBS_COLLECTION)
}
