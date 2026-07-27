# queue-cluster

A two-node `@super-line/plugin-queue` example with a browser dashboard and Control Center. Both processes use the same declarative queue configuration and coordinate through one Postgres database. The queue has cluster-wide concurrency `2`: across both nodes, no more than two `report` jobs run at once.

At startup, `node-1` inserts eight deterministic jobs and creates a UTC cron schedule that runs every minute. Both nodes compete for the same persistent slot rows, so the logs show work distributed without exceeding the global concurrency limit. A libp2p mDNS adapter connects the nodes for inspector topology, cluster presence, and queue wake hints; Postgres remains the job authority.

## Run everything in Docker

From this directory:

```bash
docker compose up --build
```

Open:

- Queue dashboard: [http://localhost:8080](http://localhost:8080)
- Control Center: [http://localhost:8081](http://localhost:8081)

The dashboard calls `createReportJob` and receives `{ jobId }`. It polls `listJobs` every two seconds and renders the latest 50 sanitized summaries. Its public contract contains no queue collections, lease data, or node keys.

Expected output includes both nodes processing jobs:

```text
node-1  | [node-1] started bootstrap-01 (attempt 1)
node-2  | [node-2] started bootstrap-02 (attempt 1)
node-1  | [node-1] completed bootstrap-01
node-2  | [node-2] completed bootstrap-02
```

Stop the cluster with `Ctrl-C`, then:

```bash
docker compose down
```

The `queue-pgdata` volume preserves jobs between runs. To deliberately remove it, use `docker compose down -v`.

## Run the worker nodes directly on the host

First start only the example Postgres service:

```bash
docker compose up -d postgres
pnpm host
```

`src/host.ts` launches `node-1` on port `8801` and `node-2` on port `8802` as separate host processes. In a second terminal, start the Vite dashboard against `node-1`:

```bash
pnpm dev
```

Set `QUEUE_NODE_URL` to select the other host node:

```bash
QUEUE_NODE_URL=http://localhost:8802 pnpm dev
```

Open the Vite URL it prints. Press `Ctrl-C` in both terminals to stop the UI and drain both workers. Stop Postgres afterward with:

```bash
docker compose down
```

To use an already-running Postgres instead of Docker:

```bash
PG_URL=postgres://user:password@localhost:5432/queue pnpm host
```

Run these commands from the repository root if preferred:

```bash
pnpm --filter @super-line/example-queue-cluster infra:up
pnpm --filter @super-line/example-queue-cluster host
```

## Files

- `src/queue.ts` constructs `queueKit` once per process and declares the worker, schemas, concurrency, leases, retry, and retention defaults.
- `src/dashboard-contract.ts` defines the browser-only request surface without queue collections.
- `src/contract.ts` composes that request surface with `queueKit.contract` for the server.
- `src/dashboard.ts` implements job creation and sanitized job listing.
- `src/node.ts` mounts WebSocket transport, the libp2p adapter, inspector, collections, and `queueKit.plugin`.
- `src/host.ts` launches two copies of the node process for host-mode development.
- `Caddyfile` serves the SPA and load-balances `/ws` and `/inspect` across both nodes.
- `docker-compose.yml` runs Postgres, both nodes, the dashboard, and Control Center.

Electric is intentionally absent. Queue collections are server-only, and `pgliteCollections` performs queue snapshots and conditional writes against central Postgres. The libp2p wake hint is optional; durable polling remains the correctness path.

## Documentation

- [Add a queue](https://super-line.dogar.biz/how-to/plugin-queue)
- [Enqueue and observe jobs](https://super-line.dogar.biz/how-to/queue-jobs)
- [Schedule periodic jobs](https://super-line.dogar.biz/how-to/queue-schedules)
- [Run queues across a cluster](https://super-line.dogar.biz/how-to/queue-clusters)
- [Queues and workers concept](https://super-line.dogar.biz/concepts/queues-and-workers)
