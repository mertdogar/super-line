import { DurableObject } from 'cloudflare:workers'
import { cloudflareCollections, remoteRows, syncedSql, type RemotePush, type Statement } from '@super-line/collections-cloudflare'
import { inspector } from '@super-line/plugin-inspector'
import { composeCollections, createSuperLineServer } from '@super-line/server'
import { createDurableNode, routeToNode } from '@super-line/transport-cloudflare'
import { contract } from './contract.js'

interface Env {
  NODE: DurableObjectNamespace<Node>
  STORE: DurableObjectNamespace<Store>
}

// Every browser talks to this one node. A store is named `<node>:<store id>`, so it knows which node to push to.
const NODE_NAME = 'node'

// A plain SQL database the node doesn't own: its tables are whatever SQL its users run. Every write goes through
// `query`, which captures the changed rows and pushes them to the node once the batch commits. `maxPullChanges` is
// low (default 5000) so that a 6000-row insert overflows it and shows the wipe path.
export class Store extends DurableObject<Env> {
  private sync = syncedSql(this.ctx, {
    maxPullChanges: 2000,
    onChange: (push) => {
      const [node, storeId] = this.ctx.id.name!.split(':') as [string, string]
      console.log(`store ${storeId}: clock ${push.clock}, ${push.changes ? `${push.changes.length} changes inline` : 'clock only (the node pulls)'}`)
      return this.env.NODE.getByName(node).storeChanged(storeId, push)
    },
  })

  query(statements: Statement[]) {
    return this.sync.query(statements)
  }
  snapshot(table: string, limit: number) {
    return this.sync.snapshot(table, limit)
  }
  get(table: string, id: string) {
    return this.sync.get(table, id)
  }
  changesSince(clock: number) {
    return this.sync.changesSince(clock)
  }
}

// The super-line node. This runs on first use and again on every wake from hibernation, so each "node constructed"
// line after a quiet spell is a wake.
export class Node extends createDurableNode((ctx, env: Env, base) => {
  console.log('node constructed')
  const storeRows = remoteRows({
    collection: 'storeRows',
    storage: ctx.storage,
    stub: (storeId) => env.STORE.getByName(`${ctx.id.name}:${storeId}`),
    // The store's history broke (a dropped or altered table, a backlog over maxPullChanges), so the rows its
    // readers hold may be stale. A guest may read any store and the node doesn't track which, so every socket goes;
    // each client reconnects and resubscribes into a fresh snapshot.
    onWipe: (storeId) => {
      console.log(`store ${storeId}: history broke, closing every socket with 4409`)
      for (const conn of server.local.connections) conn.raw.close(4409, 'resync')
    },
  })

  // The node's own collections would go to `default`; this contract declares none besides storeRows.
  const { storeRows: _, ...owned } = contract.collections
  const server = createSuperLineServer(contract, {
    ...base,
    authenticate: () => ({ role: 'guest' as const, ctx: {} }),
    collections: composeCollections({ default: cloudflareCollections(ctx.storage, owned), storeRows }),
    // every guest reads every store; `write` omitted, so client writes are denied
    policies: { storeRows: { read: () => undefined } },
    // the Control Center channel, open: this example runs locally only
    plugins: [inspector()],
  })

  // A wake restores subscriptions without reading the stores, so catch up every store this node has served.
  void server.ready.then(() => storeRows.resume()).catch((err) => console.error('resume failed', err))

  return Object.assign(server, { storeRows })
}) {
  // the store's onChange lands here
  storeChanged(storeId: string, push: RemotePush) {
    return this.server.storeRows.ingest(storeId, push)
  }
}

const QUERY = /^\/stores\/([^/]+)\/query$/

export default {
  // Files in ./dist are served before this runs. /ws reaches the node; POST /stores/<id>/query runs SQL in that
  // store. Anything else gets a 404 here, because every request an object receives wakes it.
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/ws') return routeToNode(request, env.NODE, { name: () => NODE_NAME })
    const match = QUERY.exec(url.pathname)
    if (!match || request.method !== 'POST') return new Response('Not found', { status: 404 })
    const storeId = decodeURIComponent(match[1]!)
    if (storeId.includes(':')) return new Response('A store id must not contain ":"', { status: 400 })
    const { statements } = await request.json<{ statements: Statement[] }>()
    return Response.json(await env.STORE.getByName(`${NODE_NAME}:${storeId}`).query(statements))
  },
} satisfies ExportedHandler<Env>
