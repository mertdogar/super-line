# Research: nodejs_compat coverage and testing under workerd

Ticket T02. Researched 2026-10-14. Every fact carries a URL. "Undocumented" means the sources fetched do not say.

## Part 1. nodejs_compat coverage for what super-line imports

### What the repo actually imports (read from source)

| Package | Import | Use |
|---|---|---|
| plugin-auth `src/crypto.ts:1` | `node:crypto`: `createHash`, `randomBytes`, `randomUUID`, `scrypt` (callback form with options object `{N, r, p}`), `timingSafeEqual`; global `Buffer` (`from(hex)`, `toString('hex'\|'base64url')`) | password hashing (N=16384, r=8, p=1, keylen 64, about 16 MiB), tokens, sha256 of tokens |
| plugin-auth `src/assertions.ts:1` | `node:crypto` `hkdfSync` | derives a JWE key from a secret |
| plugin-auth `assertions.ts:2` | `jose` | JWS/JWE (jose uses Web Crypto) |
| plugin-inspector `src/index.ts:1` | `createHash`, `timingSafeEqual` | token compare |
| plugin-chat `src/server.ts:1` | `randomUUID` | ids |
| server `src/index.ts:794`, `:983` | `process.env.SUPER_LINE_NODE_NAME` (guarded by `typeof process`), `setInterval` heartbeat | node name, liveness |

### Module-level answer

- Under `nodejs_compat`, Buffer, Crypto, Process, Timers, HTTP, Net, Path, Stream, Web Crypto are listed as fully supported. https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- Flag: compatibility dates 2024-09-23 through 2026-08-03 need `"nodejs_compat"`. From 2026-08-04 both `nodejs_compat` and `nodejs_compat_v2` are on by default. https://developers.cloudflare.com/workers/runtime-apis/nodejs/

### Per-API table

| API | Verdict | Source / note |
|---|---|---|
| `scrypt` with options (`N`,`r`,`p`) | **Supported** | The node:crypto page says "All `node:crypto` APIs are fully supported in Workers" except `generateKeyPair(Sync)` for DSA/DH, `argon2`/`argon2Sync`, `ed448`/`x448`, and manual FIPS toggling. scrypt is not in the exception list. https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/ . The docs page never mentions scrypt options or maxmem ("undocumented" on the docs side). The workerd source confirms it: `crypto_scrypt.ts` accepts `N`/`cost`, `r`/`blockSize`, `p`/`parallelization`, `maxmem` (default `32 << 20`, 32 MiB, same as Node) and exposes both `scrypt` and `scryptSync`, delegating to a native `getScrypt`, with a `checkScryptLimits` guard in C++. https://github.com/cloudflare/workerd/blob/main/src/node/internal/crypto_scrypt.ts and https://github.com/cloudflare/workerd/blob/main/src/workerd/api/node/crypto.c%2B%2B . Caveat: that is `main`, not necessarily the build deployed or the one Miniflare bundles. |
| `randomBytes` | Supported | node:crypto page, no exception. |
| `randomUUID` | Supported | node:crypto page; `globalThis.crypto.randomUUID()` also exists (Web Crypto, listed supported). |
| `createHash` (sha256) | Supported | node:crypto page, no exception. |
| `timingSafeEqual` | Supported | node:crypto page, no exception. |
| `hkdfSync` | Supported | node:crypto page, no exception. |
| `Buffer` | Supported with two differences | No memory pool; no `Buffer.allocUnsafe()` (all zero-filled). Neither is used by super-line. https://developers.cloudflare.com/workers/runtime-apis/nodejs/buffer/ . Whether scrypt's return is a `Buffer` (the repo calls `.toString('hex')` on it) is undocumented; the source returns the native `ArrayBuffer`, so a prototype should assert it. |
| `process.env` | Supported, flag-gated | Empty by default; populated with vars, secrets and metadata when `nodejs_compat` is on and `nodejs_compat_populate_process_env` is set, which is the default for compat dates on or after 2025-04-01. Values are coerced to strings. https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/ . The server's `typeof process !== 'undefined'` guard already tolerates absence. |
| `setInterval` | Supported, but semantically weak | Timers "only return the time of the last I/O" and "will not delay them for the full time specified". https://developers.cloudflare.com/workers/runtime-apis/nodejs/timers/ . More important for the map: in a Durable Object, `setTimeout`/`setInterval` usage prevents hibernation. https://developers.cloudflare.com/durable-objects/best-practices/websockets/ . So the heartbeat timer works but must be replaced by transport liveness, as the map already decided. |
| `ws` (npm) | **Not bundleable as the DO transport** | ws README: "This module does not work in the browser" (Node targeted). https://github.com/websockets/ws . It never mentions Workers (undocumented). Workers' `node:http` `createServer` works but "The `'upgrade'` event is not supported" and the `'socket'` event is unsupported. https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/ . ws's server path depends on the upgrade event and raw sockets, so the DO transport must be a separate implementation on `WebSocketPair` / `ctx.acceptWebSocket`. Confirms the expectation. |

### Answer to "is the crypto-port ticket real work or a no-op?"

- **For the crypto functions themselves, it is close to a no-op.** Every `node:crypto` function super-line uses is documented supported, and scrypt-with-options is present in workerd's source with Node's 32 MiB default maxmem. The 16 MiB the repo uses fits under it and under the 128 MB isolate limit. https://developers.cloudflare.com/workers/platform/limits/
- **It is still real, small work for three reasons:**
  1. `nodejs_compat` becomes a hard requirement of the plugins (a peer/doc note, plus the flag in wrangler config).
  2. The scrypt return type and `Buffer` interop need one assertion test inside workerd.
  3. CPU cost of scrypt (N=16384, r=8) per login inside a DO is undocumented. The DO CPU limit is 30 s default per request or message, resettable per event, so it is unlikely to bind. https://developers.cloudflare.com/durable-objects/platform/limits/
- **WebCrypto alternative:** Web Crypto has no scrypt (Web Crypto offers PBKDF2, HKDF, not scrypt; general knowledge, not fetched). Moving off node scrypt would change the stored hash format, so only do it if the prototype shows scrypt failing. `hkdfSync` and `createHash` have trivial Web Crypto equivalents but are async, so changing them forces async ripple; not needed if node:crypto is supported.

## Part 2. Testing

### Package state (important, changes the plan)

- `@cloudflare/vitest-pool-workers` is **renamed** to `@cloudflare/vitest-plugin`. npm marks the pool deprecated: "has been renamed to @cloudflare/vitest-plugin. This package will not receive future updates." Pool latest is 0.23.0 and peers `vitest ^4.1.0`. https://registry.npmjs.org/@cloudflare/vitest-pool-workers . Migration guide: "The package API and Vitest configuration are unchanged." https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/
- `@cloudflare/vitest-plugin` 1.4.2 peers `vitest ^4.1.0 || ^5.0.0`. https://registry.npmjs.org/@cloudflare/vitest-plugin/latest . Docs: "requires Vitest 4.1 or later". https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/
- **The repo runs vitest 2.1.9** (`package.json` `^2.1.8`, `node_modules/vitest` is 2.1.9). The last pool line that supports vitest 2 is 0.12.0 (peer `2.0.x - 3.2.x`), and it is deprecated. Vitest 3 support ended at 0.8.x-0.12.x. So the map's "`@cloudflare/vitest-pool-workers`" has two options: (a) pin a deprecated pool and stay on vitest 2/3, or (b) move the whole repo to vitest 4.1+ (also what the maintained plugin needs). The map text should say "Workers Vitest integration" and the third lane may force a vitest upgrade. Vitest 4 migration guide for the plugin: https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/ (listed, body not read).
- Config API now: add `cloudflareTest({ wrangler: { configPath }, miniflare: {...} })` to `plugins`; old `defineWorkersConfig` was replaced from pool 0.13.0 (Context7 from the workers-sdk changelog). https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ . "Custom Vitest `environment`s or `runner`s are not supported."

### Coexistence with a root `pool: 'forks'` config

- The Cloudflare docs do **not** discuss projects/workspaces or multiple pools (the configuration and get-started pages say nothing). Undocumented there.
- Vitest's own docs: one root config can hold `test.projects`; "Vitest provides a way to define multiple project configurations within a single Vitest process"; inline projects inherit root `plugins` and `pool`, `extends: false` opts out; `--project` filters with `*` and `!`. https://vitest.dev/guide/projects (page describes v5.0.4). A per-project `pool` override is not shown explicitly there; verify.
- workers-sdk's own fixtures use a Workers project under `test.projects` with `cloudflareTest()` and note a node project must be a separate project without the plugin. https://github.com/cloudflare/workers-sdk/blob/main/fixtures/vitest-plugin-examples/basics-unit-integration-self/vitest.config.ts (via Context7).
- **Conclusion:** coexistence is feasible two ways. Recommended: a **separate config file** (`vitest.workers.config.ts`) run by `pnpm test:workers`, mirroring how the heavy lane already uses its own config (`vitest.integration.config.ts`). It never touches the root `forks` pool, keeps the existing serial lanes unchanged, and avoids the question of how project-level `pool`/`fileParallelism` merge. The root config currently has top-level `pool: 'forks'` and `fileParallelism: false`, which inline projects would inherit unless `extends: false`. The projects route is possible but not proven by any source read. Either way the vitest version problem above applies to the process that runs the workers config.
- Also: the root `vitest.config.ts` aliases `@super-line/*` to `src/` via `resolve.alias`; the workers config must repeat those aliases (they are exported as `alias`, so it can import them).

### Durable Objects and hibernation in the harness

- Test APIs in `cloudflare:test`: `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `listDurableObjectIds`, `reset`, `abortAllDurableObjects`, `evictAllDurableObjects`; `env`/`exports` from `cloudflare:workers`. https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- **A test can force hibernation:** `evictDurableObject`: "By default, hibernatable WebSockets are hibernated rather than closed"; option `webSockets: 'hibernate' | 'close'`; it waits for in-flight requests up to 30 s, rejects if the object is not running. `abortAllDurableObjects` discards in-memory state without draining and keeps persisted data (crash simulation). `runDurableObjectAlarm` runs and removes the pending alarm, returns boolean. Same page.
- **Blocking limitation:** "Using WebSockets with Durable Objects is not supported with per-file storage isolation." Workaround: run with `--max-workers=1 --no-isolate`. https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/ . So the workers lane must run serially with isolation off, which fits the repo's serial-lane norm but means storage is not auto-reset between files (use `reset`).
- Other known issues that touch us: dynamic `import()` fails inside DO handlers (static imports only); native V8 coverage unsupported (Istanbul only); global setup files run in Node, not workerd. Same page.
- **Whether a test can observe a real wake on a hibernated socket end to end** (message arrives after evict, constructor reruns, handlers fire) is **undocumented**; the docs state eviction hibernates sockets but do not show a wake-on-message test. Prototype needed.

### `wrangler dev` as fallback

- Local dev hibernation: before `wrangler@3.13.2` / Miniflare `v3.20231016.0` local sockets did not hibernate; hibernatable events are delivered but "the Durable Object is never evicted from memory" in that case. Newer versions are implied to evict, but the page does not say how or when. https://developers.cloudflare.com/durable-objects/best-practices/websockets/ . Timers prevent hibernation in dev as in prod, so a real-eviction check by waiting needs a node with no `setInterval`.
- Limits useful for design: serializeAttachment max 16,384 bytes (supports the map's expectation to snapshot into DO SQLite); received WebSocket message max 32 MiB; DO SQLite 10 GB on paid. https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/platform/limits/

### Cost of a third CI lane

Undocumented by Cloudflare (no CI guidance on the pages read). From the repo and sources: the lane needs no Docker or network (Miniflare runs fully locally, https://developers.cloudflare.com/workers/testing/vitest-integration/), but must run serial and non-isolated, adds the `@cloudflare/vitest-plugin` + `workerd` binary download to install, and likely a vitest major upgrade for the whole repo. No measured timings exist; the first suite will be the measurement.

## Facts for the ticket decision

- `scrypt` with options: supported under `nodejs_compat` (docs: fully supported; workerd source: options and 32 MiB maxmem present).
- `ws` cannot be the DO transport; build separately.
- Vitest-pool-workers coexists with a forks-pool root only via a separate config/lane (or an unproven projects setup), and the maintained package needs vitest 4.1+ while the repo is on 2.1.9.
- Hibernation can be forced in tests with `evictDurableObject`, but DO WebSocket tests require `--max-workers=1 --no-isolate`.
