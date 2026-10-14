---
id: T02
title: Research: nodejs_compat coverage and testing under workerd
labels: [wayfinder:research]
status: closed
assignee: research agent (2026-10-14)
closed: 2026-10-14
blocked-by: []
---

## Question

Two facts, from Cloudflare's docs with citations:
1. **`nodejs_compat` coverage** for exactly what super-line imports: `node:crypto` `scrypt` (with options), `randomBytes`, `randomUUID`, `createHash`, `timingSafeEqual`; `Buffer`; `process.env`; `setInterval`. For each: supported, partial, or absent — and whether the WebCrypto alternative is the only path. The answer decides whether the crypto-port ticket is real work or a no-op. Also check `ws` (npm) — can it be bundled at all, or must the DO transport be a separate implementation (expected: separate).
2. **Testing**: `@cloudflare/vitest-pool-workers` — how it coexists with a root vitest config that uses `pool: 'forks'` (separate config file? workspace projects?), whether Durable Objects + hibernation can be exercised in it (`runInDurableObject`, `runDurableObjectAlarm`, can a test force a hibernation/wake?), and the cost of a third lane in CI. Also wrangler's local dev (`wrangler dev`) as the fallback for behaviors the pool cannot force.
Write findings to `.scratch/cloudflare-workers/assets/research-nodejs-compat-and-testing.md`.

## Resolution

Findings: [assets/research-nodejs-compat-and-testing.md](../assets/research-nodejs-compat-and-testing.md)

1. `node:crypto` is documented fully supported under `nodejs_compat` except DSA/DH keygen, argon2, ed448/x448, FIPS toggle. Nothing super-line imports is excepted.
2. scrypt with options: supported. Docs are silent on options, but workerd source has N/r/p/maxmem (32 MiB default, same as Node).
3. The crypto-port ticket is nearly a no-op: add the `nodejs_compat` requirement and one in-workerd test for scrypt and Buffer interop.
4. `process.env` works when populated (default for compat dates from 2025-04-01); `setInterval` works but blocks DO hibernation.
5. `ws` cannot be bundled as the transport: node:http upgrade is unsupported. The DO transport is a separate implementation.
6. `@cloudflare/vitest-pool-workers` is deprecated and renamed `@cloudflare/vitest-plugin`; it needs vitest 4.1+, the repo is on 2.1.9. The last vitest-2-compatible pool is 0.12.0.
7. Coexistence with the forks root: use a separate config and `pnpm test:workers`; the projects route is unproven by any source.
8. Hibernation can be forced via `evictDurableObject` (sockets hibernate by default); `abortAllDurableObjects` simulates a crash.
9. DO WebSocket tests need `--max-workers=1 --no-isolate`. A true wake-on-message test is undocumented and needs a prototype.
10. CI cost of the third lane is undocumented; `wrangler dev` is the fallback, with hibernation only when no timers are pending.
