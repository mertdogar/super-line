---
id: T14
title: Decide: upgrade vitest repo-wide or pin the deprecated workers pool
labels: [wayfinder:grilling]
status: open
assignee:
blocked-by: [T02]
---

## Question

T02 found that `@cloudflare/vitest-pool-workers` is deprecated in favor of `@cloudflare/vitest-plugin`, which requires vitest ≥ 4.1; the repo is on vitest 2.1.9, and the last pool release supporting vitest 2 (0.12.0) is itself deprecated. The workers lane therefore cannot be added without one of:
(a) upgrading vitest repo-wide to 4.x (touches both existing lanes, `pool: 'forks'`, serial settings, and every test file that hits a breaking change — the fast lane's flakiness budget is tuned against 2.x),
(b) pinning the deprecated 0.12.0 pool for the workers lane only on a separate config (works today, rots), or
(c) running the workers lane on `wrangler dev` + a plain vitest client with no in-workerd pool (loses `evictDurableObject` / `runInDurableObject`, which are exactly what proves hibernation).

Decide with the user. Fact to establish first: run the existing fast lane under vitest 4.x in a scratch checkout and count breakages. Also decide whether a vitest upgrade, if chosen, is its own preparatory commit on main before this effort's work starts.
