import { z } from 'zod'
import { defineContract } from '@super-line/core'

// A single shared topic. Because it is a *shared* topic, it is the cluster event bus:
//   srv.publish('announce', …)               — any node publishes
//   srv.subscribe('announce', (data) => …)   — any server-side code subscribes (local echo)
//   client.subscribe('announce', (data) => …) — any connected client subscribes (over WS)
export const bus = defineContract({
  shared: {
    serverToClient: {
      announce: { payload: z.object({ text: z.string() }), subscribe: true },
    },
  },
  roles: { watcher: {} },
})
