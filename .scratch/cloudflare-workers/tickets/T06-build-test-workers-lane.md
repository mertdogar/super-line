---
id: T06
title: Build the test:workers lane
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T05,T14]
---

## Question

Add the third lane: `pnpm test:workers` on `@cloudflare/vitest-pool-workers` with its own config (per T02's coexistence finding), a smoke test proving a DO with a hibernated WebSocket can be exercised, wired into CI alongside fast/integration, and documented in CLAUDE.md's Commands + Gotchas. Keep the fast lane serial and untouched.
