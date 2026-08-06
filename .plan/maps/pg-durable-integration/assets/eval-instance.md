# pg_durable local eval instance — bring-up and observed behavior

Stood up 2026-08-07 on macOS (Apple Silicon), Docker 29.6.2. Image pinned to the
immutable tag matching the release the deep-dive documented.

## Bring-up (repeatable)

```bash
# 1. No arm64 image is published (README warns) — pull amd64 explicitly.
#    A bare pull on Apple Silicon fails with "no matching manifest for linux/arm64".
docker pull --platform linux/amd64 ghcr.io/microsoft/pg_durable:0.2.5-pg17

# 2. Run. Port 54517 chosen because 5432/5433 were taken locally.
docker run -d --name pg-durable-eval --platform linux/amd64 \
  -p 54517:5432 -e POSTGRES_PASSWORD=pgdurable \
  ghcr.io/microsoft/pg_durable:0.2.5-pg17

# 3. Wait ~40s. Init is the standard postgres-image dance: temp server →
#    /docker-entrypoint-initdb.d/01-init-pg-durable.sh runs CREATE EXTENSION →
#    shutdown → final server. Ready when logs show:
#      pg_durable: duroxide runtime started
#      pg_durable: epoch sentinel written (<uuid>)
docker logs pg-durable-eval 2>&1 | tail -5

# 4. Talk to it (in-container psql; note -i for heredocs/stdin):
docker exec -i pg-durable-eval psql -U postgres
# or from the host: psql "postgresql://postgres:pgdurable@localhost:54517/postgres"

# Teardown when no longer needed:
docker rm -f pg-durable-eval
```

Emulation (QEMU/Rosetta for linux/amd64) worked without issue — worker boots,
timers fire, no crashes over the session.

## What was run and observed (transcript highlights)

Three durable functions via `df.start()`, all completed correctly:

```
SELECT df.start('SELECT 41' |=> 'x' ~> 'SELECT ($x)::int + 1 AS answer', 'smoke');
SELECT df.start(
  ('SELECT count(*) FROM eval_users' |=> 'u')      -- 7 rows
  & ('SELECT count(*) FROM eval_orders' |=> 'o')   -- 3 rows
  ~> 'SELECT ($u)::int + ($o)::int AS total', 'fanout');
SELECT df.start('SELECT 1' ~> df.sleep(8) ~> 'SELECT 99 AS late', 'sleeper');
```

| instance | label | result (`df.result`) | duration (`completed_at - created_at`) |
|---|---|---|---|
| 56b67f8f | smoke | `{"rows": [{"answer": 42}], "row_count": 1}` | 1.64s |
| 1cdc53dc | fanout | `{"rows": [{"total": 10}], "row_count": 1}` | 1.82s |
| 44c4cdc0 | sleeper | `{"rows": [{"late": 99}], "row_count": 1}` | 9.89s (8s durable timer + ~1.9s overhead) |

- Result envelope is always `{"rows": [...], "row_count": N}` JSON text.
- `df.instance_nodes('44c4cdc0')` showed the full node tree (THEN/SLEEP/SQL) with
  per-node status + results; the SLEEP node's result is `{"slept": true, "seconds": 8}`.
- ~1.6–1.9s of orchestration overhead on a trivial graph (under emulation) — each
  activity is a checkpoint round-trip through `_duroxide` queue tables at a 100ms
  poll floor, so sub-second workflows aren't the design point.
- Cancellation: `df.start(df.sleep(300), 'cancel-me')` → `df.cancel(id, reason)`
  returned `Instance 8e1604fe cancelled: eval teardown test`; status `cancelled`
  ~2s later.

## Environment facts (verified live)

- `pg_extension`: pg_durable **0.2.5** on PostgreSQL **17.10**, `shared_preload_libraries = pg_durable`.
- `pg_durable.enable_superuser_instances = on` — the eval image's demo setting
  (default is `off`); everything here ran as the `postgres` superuser.
- Connection budget logged at boot: `management=6, duroxide=10, user=10` (defaults).
- Schemas: `df` + `_duroxide` (fresh install uses the renamed provider schema, as
  the deep-dive predicted). `_duroxide` tables: `_duroxide_migrations`,
  `_worker_ready`, `executions`, `history`, `instance_locks`, `instances`,
  `kv_delta`, `kv_store`, `orchestrator_queue`, `sessions`, `worker_queue`
  (note `kv_delta` — not in the deep-dive's captured migration list).
- **`wal_level = replica`** out of the box → the Electric-coexistence test must
  start the container with `-c wal_level=logical` (append
  `postgres -c wal_level=logical` as the container command, or a fresh container).
- RLS seen live on `df.instances`: policy `instances_user_isolation`
  `USING (submitted_by::oid = quote_ident(current_user)::regrole::oid)`.

## Doc-vs-reality drift caught (0.2.5 vs `main` docs)

The deep-dive notes were fetched from `main` (mid-v0.2.6) and describe
`df.instances` with an `output` column. **Released 0.2.5 has no `output` column**
(it has `updated_at` instead, which the notes' table omitted); the final result
lives on the terminal node's `result` and is surfaced by `df.result()` /
`df.list_instances()`'s `output` column. Anything reading `df.instances` directly
(e.g. an Electric shape) must join `df.nodes` or use the functions if it wants
results — and must expect this shape to change across extension upgrades.

## State left behind

Container `pg-durable-eval` is **left running** on port 54517 (password
`pgdurable`, db `postgres`) for follow-on tickets. It contains the demo tables
(`eval_users`, `eval_orders`) and the four instances above. Retention defaults
(30 days / 10k cap) mean nothing will be reaped mid-effort.
