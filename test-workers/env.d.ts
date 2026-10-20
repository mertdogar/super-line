import type { AppNode, AuthNode, RawNode, RowsNode, SmokeNode, SqlSourceNode, StoreNode } from './worker.js'

// Bindings of ./wrangler.jsonc, typed once for the Worker, the DO classes and `env` from `cloudflare:test`.
declare global {
  namespace Cloudflare {
    interface Env {
      SMOKE: DurableObjectNamespace<SmokeNode>
      RAW: DurableObjectNamespace<RawNode>
      APP: DurableObjectNamespace<AppNode>
      STORE: DurableObjectNamespace<StoreNode>
      AUTH: DurableObjectNamespace<AuthNode>
      SQL_SOURCE: DurableObjectNamespace<SqlSourceNode>
      ROWS: DurableObjectNamespace<RowsNode>
    }
  }
}
