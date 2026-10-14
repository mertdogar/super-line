---
id: T06
title: Build the test:workers lane
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T05,T14]
---

## Question

Add the third lane: `pnpm test:workers` on `@cloudflare/vitest-plugin` (`cloudflareTest()` in `plugins`; the pool package is deprecated) with its own `vitest.workers.config.ts` importing the root `alias`, the script carrying `--max-workers=1 --no-isolate`, `pnpm test` extended to run all three lanes (T14 decisions), a smoke test proving a DO with a hibernated WebSocket can be exercised, wired into CI alongside fast/integration, and documented in CLAUDE.md's Commands + Gotchas. Keep the fast lane serial and untouched. Includes the crypto verification test folded in from T08: run the real plugin-auth crypto functions (scrypt with options, `hkdfSync`, `timingSafeEqual`, `randomBytes`, `Buffer` hex/base64url round-trips) and the inspector token compare inside workerd, and document `nodejs_compat` as a hard requirement.
