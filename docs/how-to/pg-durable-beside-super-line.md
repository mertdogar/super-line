# Run pg_durable beside super-line

[pg_durable](https://github.com/microsoft/pg_durable) is Microsoft's durable-execution extension for
PostgreSQL: workflows written as SQL step graphs, checkpointed by a background worker **inside the
database**, resumed after crashes and restarts. If your deployment already runs a central Postgres for the
`self` collection tier ([pgliteCollections](/collections/backends)), the two can share one instance. This
page covers what that takes, where the boundary with super-line's own job machinery sits, and how to watch
pg_durable's workflows live through the same Electric replication super-line already uses.

::: warning Preview software
pg_durable is a preview (0.x) extension for PostgreSQL 17/18 only, and its binary upgrades have
historically broken **in-flight** workflow replay — its own docs tell operators to drain running instances
before upgrading. Plan for that churn before putting it on a production path.
:::

## Which tool for which work

A pg_durable step is a SQL statement or an HTTP call — nothing else. It cannot run your application code,
so it never competes with [plugin-queue](/how-to/plugin-queue), whose workers are TypeScript closures in
your server process. The split that holds up in practice:

| Work | Tool |
|---|---|
| In-database batch and ETL, per-row pipelines, SQL maintenance with retries and waits | pg_durable |
| App-tier jobs — anything that is your TypeScript, touches your services, or needs your process | plugin-queue |

Two consequences worth knowing before you design across the boundary:

- **HTTP egress is a build-time allow-list.** The released pg_durable packages only reach Azure domains, so
  `df.http()` cannot call back into a self-hosted server unless you build the extension from source with
  your own allow-list.
- Starting a workflow from super-line is just SQL: any server-side request handler can run
  `SELECT df.start('…', 'label')` through your Postgres client against the shared instance and get an
  instance id back immediately.

## Sharing one Postgres

pg_durable and Electric coexist cleanly on a single PostgreSQL instance — workflows run normally while
Electric's replication slot streams, with no interference in either direction. What the shared instance
must provide:

- **PostgreSQL 17 or 18.** pg_durable sets the floor; Electric and `pgliteCollections` are fine there, so
  the joint requirement is simply PG ≥ 17.
- **`wal_level = logical`** — Electric already requires this, so a `self`-tier Postgres has it.
- **`shared_preload_libraries = 'pg_durable'`** plus a restart, and `CREATE EXTENSION pg_durable` as a
  superuser in the one database named by the `pg_durable.database` setting (default `postgres`). Point that
  setting at the database your collections live in if you want everything in one database.
- **A superuser worker role** (`pg_durable.worker_role`) — that is the extension's design, not an option.
- **Connection headroom.** The background worker holds about 26 client backends at default settings, before
  Electric's own connections — size `max_connections` accordingly.
- `DROP EXTENSION pg_durable` always needs `CASCADE`.

The extension keeps to its own schemas — `df` (workflow tables) and `_duroxide` (runtime state) — and sits
beside your `col_*` tables without ceremony.

## Watch workflows live through Electric

`df.instances` — one row per workflow instance — can be synced like any other table. A shape request
against your Electric endpoint:

```bash
curl "http://localhost:3000/v1/shape?table=df.instances&offset=-1"
```

A workflow's lifecycle then arrives as ordinary row messages: an `insert` with status `pending`, partial
`update` diffs as it moves through `running` to `completed` (or `failed`/`cancelled`), and the final result
retrievable with `df.result(id)`. Electric adds the table to its publication and sets
`REPLICA IDENTITY FULL` on it the first time a shape touches it.

Four caveats, all observed behavior:

1. **Row security does not scope the stream.** Logical replication bypasses RLS, so the shape carries
   *every* user's instances regardless of who submitted them. Consume the shape server-side and filter with
   your own read policies before anything fans out to clients — the same server-authoritative model
   [collection policies](/collections/policies) use everywhere else.
2. **The table's shape drifts between extension versions.** For example, 0.2.5 has no `output` column —
   results live on terminal nodes and surface only through `df.result()`. Treat any direct reader of
   `df.instances` as coupled to the extension version.
3. **Retention reaping shows up as bulk deletes.** The extension periodically removes terminal instances
   (30 days by default, with a hard cap on retained rows); a long-lived shape sees those as waves of
   key-only delete messages.
4. Updates arrive as **partial diffs** (only changed columns) and deletes carry only the key — plan your
   consumer around both, or read the full row back on change.

## Next steps

- [Choose a collection backend](/how-to/choose-a-collection-backend) — where the `self` tier and its
  central Postgres fit.
- [Add a queue (plugin)](/how-to/plugin-queue) — super-line's own durable jobs, cron, and workers.
- The [pg_durable user guide](https://github.com/microsoft/pg_durable/blob/main/USER_GUIDE.md) — the DSL,
  monitoring functions, and privilege model in full.
