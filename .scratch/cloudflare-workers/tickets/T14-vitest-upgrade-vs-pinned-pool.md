---
id: T14
title: Decide: upgrade vitest repo-wide or pin the deprecated workers pool
labels: [wayfinder:grilling]
status: closed
assignee: claude session 2026-10-14 (T14)
closed: 2026-10-14
blocked-by: [T02]
---

## Question

T02 found that `@cloudflare/vitest-pool-workers` is deprecated in favor of `@cloudflare/vitest-plugin`, which requires vitest ≥ 4.1; the repo is on vitest 2.1.9, and the last pool release supporting vitest 2 (0.12.0) is itself deprecated. The workers lane therefore cannot be added without one of:
(a) upgrading vitest repo-wide to 4.x (touches both existing lanes, `pool: 'forks'`, serial settings, and every test file that hits a breaking change — the fast lane's flakiness budget is tuned against 2.x),
(b) pinning the deprecated 0.12.0 pool for the workers lane only on a separate config (works today, rots), or
(c) running the workers lane on `wrangler dev` + a plain vitest client with no in-workerd pool (loses `evictDurableObject` / `runInDurableObject`, which are exactly what proves hibernation).

Decide with the user. Fact to establish first: run the existing fast lane under vitest 4.x in a scratch checkout and count breakages. Also decide whether a vitest upgrade, if chosen, is its own preparatory commit on main before this effort's work starts.

## Resolution

**Upgrade vitest repo-wide to 4.x (user: 1a 2a 3a 4a).**

Fact established first, in a scratch worktree at HEAD with only `vitest ^2.1.8 → ^4.1.11` changed and both lane configs untouched:

| lane | result under vitest 4.1.11 |
|---|---|
| fast (`pnpm test:fast`) | 89 files / 844 tests, all pass, 73 s, no deprecation warnings |
| heavy (`pnpm test:integration`, Docker) | 33 files / 164 tests: 157 pass, 6 skipped, **1 fail** (`plugin-workflows` "resumes a SIGKILLed process"), reproducible in isolation, plus "something prevents Vite server from exiting" → exit 1 |

The one failure was **a latent test bug vitest 4 made deterministic, not a vitest regression**: the test spawned `node_modules/.bin/tsx`, a launcher around a node child, and `SIGKILL`ed the launcher — the real worker survived as an orphan (three were found alive, one from a vitest 2 run), kept polling Postgres and raced the test's own server for the post-timer `aggregate` step; its inherited stdout pipe is also what kept the Vite server from exiting. Fixed in `packages/plugin-workflows/test/postgres.integration.test.ts` by spawning `process.execPath --import tsx` directly (no launcher). After the fix the file passes 3/3 under both vitest 4 and vitest 2 with zero orphans and no hanging-process warning.

Zero breakages, so options (b) pin the deprecated pool 0.12.0 (peers `vitest 2.0.x - 3.2.x`, last published 2026-01-07, deprecated) and (c) `wrangler dev` without an in-workerd pool (loses `evictDurableObject`, the call that proves hibernation) lost their only justification. The maintained package is `@cloudflare/vitest-plugin` (1.4.2, peers `vitest ^4.1.0 || ^5.0.0`).

Decisions:
1. **Root `vitest` → `^4.1.11`**; `examples/queue-cluster` carries its own `^2.1.8` and moves with it. Lane configs stay as they are (`poolOptions` was removed in v4 but the repo never used it).
2. **Preparatory `chore(deps)` commit on main before any Cloudflare work**, gated on both lanes green, so a vitest regression can never be confused with a transport bug. Ask before committing.
3. **Workers lane = separate `vitest.workers.config.ts` + `pnpm test:workers`**, mirroring the heavy lane's own config; `--max-workers=1 --no-isolate` baked into the script (the DO-WebSocket limitation from T02); imports the exported `alias` from the root config.
4. **`pnpm test` becomes fast + heavy + workers.** A lane that runs only when remembered is the `pnpm -r test` trap again. CLAUDE.md Commands/Gotchas updated with the lane when T06 lands.

Verification ran in a throwaway git worktree (since removed); the bump was then applied to the main checkout and the full suite rerun there before the prep commit.
