---
id: T06
title: Build the test:workers lane
labels: [wayfinder:task]
status: closed
assignee: claude session 2026-10-14 (T06)
closed: 2026-10-14
blocked-by: [T05,T14]
---

## Question

Add the third lane: `pnpm test:workers` on `@cloudflare/vitest-plugin` (`cloudflareTest()` in `plugins`; the pool package is deprecated) with its own `vitest.workers.config.ts` importing the root `alias`, the script carrying `--max-workers=1 --no-isolate`, `pnpm test` extended to run all three lanes (T14 decisions), a smoke test proving a DO with a hibernated WebSocket can be exercised, wired into CI alongside fast/integration, and documented in CLAUDE.md's Commands + Gotchas. Keep the fast lane serial and untouched. Includes the crypto verification test folded in from T08: run the real plugin-auth crypto functions (scrypt with options, `hkdfSync`, `timingSafeEqual`, `randomBytes`, `Buffer` hex/base64url round-trips) and the inspector token compare inside workerd, and document `nodejs_compat` as a hard requirement.

## Resolution

**Built.** The workers lane exists and is green: 2 files / 7 tests in ~2 s, no Docker.

- `vitest.workers.config.ts`: `cloudflareTest({ wrangler: { configPath: './test-workers/wrangler.jsonc' } })`, root `alias` reused, include `test-workers/**/*.workers.test.ts` + `packages/**/test/**/*.workers.test.ts`. The fast lane excludes `**/*.workers.test.ts` (its only change). `pnpm test:workers` = `vitest run --config vitest.workers.config.ts --max-workers=1 --no-isolate`; `pnpm test` runs all three lanes.
- `test-workers/`: `wrangler.jsonc` (`nodejs_compat`, `SmokeNode` DO with `new_sqlite_classes`), `worker.ts` (a DO that counts its own constructions in SQLite and echoes over a hibernatable socket), `env.d.ts` (bindings typed via `Cloudflare.Env`), `tsconfig.json` (workers-types experimental + plugin types + node). `pnpm typecheck` now also checks it; `pnpm lint` covers it.
- `smoke.workers.test.ts` proves the platform facts T07 builds on: a message after `evictDurableObject` is answered by a **new instance** (`boots=2`) over the **same socket**; SQLite and the attachment survive eviction.
- `packages/plugin-auth/test/crypto.workers.test.ts` (the T08 fold): the real `hashPassword`/`verifyPassword` (scrypt with `{N,r,p}`, `timingSafeEqual`), a hash produced by Node 24 verifying under workerd, `randomBytes`/`randomUUID`/`createHash`/`Buffer` token shapes, `hkdfSync` + jose signed and sealed assertion round-trips, and `plugin-inspector` constructing. **No port needed; `nodejs_compat` is a hard requirement**, documented in CLAUDE.md now and in the how-to at T12.
- Deps: `@cloudflare/vitest-plugin ^1.4.2`, `@cloudflare/workers-types` at root; `workerd` build script approved in `pnpm-workspace.yaml` (pnpm also recorded `minimumReleaseAgeExclude` entries for the plugin/miniflare/wrangler versions).
- Also fixed on the way: `packages/server/test/global-docker.ts` imported `GlobalSetupContext`, renamed to `TestProject` in vitest 4 — the earlier `chore(deps): vitest 4` commit had left root `pnpm typecheck` red.
- **CI**: there is no test workflow in `.github/workflows` (only devtools-extension and docs), so "wired into CI alongside fast/integration" has nothing to wire into; `pnpm test` is the contract.
- CLAUDE.md Commands + Gotchas updated.
