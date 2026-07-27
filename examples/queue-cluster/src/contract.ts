import { defineContract } from '@super-line/core'
import { dashboardSurface } from './dashboard-contract.js'
import { queueKit } from './queue.js'

export const app = defineContract({
  roles: { dashboard: dashboardSurface },
  plugins: [queueKit.contract],
})
