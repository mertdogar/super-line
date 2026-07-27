# Run queues across a cluster

Use a shared Postgres authority for queues on more than one server. The Postgres-backed `pgliteCollections` backend serializes conditional claims, so configured concurrency is cluster-wide rather than per process.

```ts
const collections = await pgliteCollections({
  pgUrl: process.env.PG_URL!, collections: app.collections ?? {}, tablePrefix: 'app_',
})
createSuperLineServer(app, {
  nodeName: process.env.NODE_NAME, nodeKey: process.env.NODE_KEY!,
  collections, plugins: [queueKit.plugin],
})
```

Every node runs the same queue definition. For concurrency two, the plugin creates two durable slots; all nodes compete for those slots. Keep `nodeKey` stable for a replica across restarts. A super-line adapter is optional for job correctness, but useful for Control Center, topology, and low-latency wake and cancellation hints. Durable polling and Postgres conditional batches remain the correctness path.

On `server.close()`, the plugin stops claiming and waits for `shutdownGraceMs`. It then aborts remaining workers. After a crash, an expired lease makes the job available again; a fencing `runId` prevents an old worker settling a reclaimed run. Make every external effect idempotent.

See [`queue-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/queue-cluster) for Docker and direct-host two-node operation with libp2p, Caddy, a browser dashboard, and Control Center.
