---
type: task
blocked_by: []
---
# Stand up a local pg_durable eval instance

## Question

Get `ghcr.io/microsoft/pg_durable:pg17` running locally in Docker, run the README
quick example plus one multi-step function (fan-out + join), and watch it in
`df.instances`. Record the exact bring-up commands and every gotcha (the extension
always installs into the `postgres` database; the eval image runs superuser durable
instances and ships an Azure-domains-only HTTP egress policy — fine for learning,
never production). Pin an immutable `X.Y.Z-pg17` tag.

This instance is the empirical ground for the coexistence research (ticket 04) and
any claim the report makes about observed behavior.

## Done when

A repeatable bring-up doc lands in `assets/eval-instance.md` (commands + psql
session transcript) with a successful `df.start()` observed through `df.instances`.

## Answer

Resolved 2026-08-07. Bring-up doc with commands, transcript, and gotchas:
[eval-instance.md](../assets/eval-instance.md). Container **pg-durable-eval**
(pg_durable 0.2.5 / PostgreSQL 17.10, pinned tag `0.2.5-pg17`) is left running on
port 54517 (`postgres`/`pgdurable`) for follow-on tickets.

Verified live: the quick-example shape, a fan-out `&`-join with `$name` result
capture, an 8s durable timer (9.89s wall — ~1.9s orchestration overhead per
trivial graph under emulation), and `df.cancel()` → `cancelled`, all observed
through `df.instances`/`df.instance_nodes`/`df.result`.

Facts later tickets depend on:

- **No arm64 image** — pull/run with `--platform linux/amd64`; emulation works.
- **`wal_level=replica` by default** — the Electric-coexistence test needs a
  container started with `-c wal_level=logical`.
- Fresh install confirmed on the `_duroxide` provider schema; 11 runtime tables
  listed in the asset (incl. `kv_delta`, absent from the deep-dive's list).
- **Doc-vs-reality drift**: released 0.2.5's `df.instances` has NO `output`
  column (docs on `main` describe v0.2.6). Results live on terminal nodes /
  `df.result()` — a direct reader of `df.instances` can't get outputs, and the
  table shape moves between extension versions.
- `enable_superuser_instances=on` is an eval-image-only demo setting.
