import type { SmokeNode } from './worker.js'

// Bindings of ./wrangler.jsonc, typed once for the Worker, the DO classes and `env` from `cloudflare:test`.
declare global {
  namespace Cloudflare {
    interface Env {
      SMOKE: DurableObjectNamespace<SmokeNode>
    }
  }
}
