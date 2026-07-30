# PLAN — Test flakiness: readiness on the server, and waits that survive a loaded machine

Find and fix the cause of tests that pass alone and fail in the full suite. The investigation
found two compounding causes — a permanently contended machine, and a suite whose waits, fixtures
and teardown all assume a quiet one — plus a structural gap underneath a third of the symptoms:
**the server has no way to tell a caller that a declared interest is actually established.**

Designed 2026-07-29 in a `/grilling` session, after measuring the machine, reading every
`void`-discarded promise in `packages/server/src`, and running `pnpm test` six times to get a
flake rate. The driving question: **why does the same test pass alone and fail in the suite?**

## Status

**BUILT — all phases complete, 2026-07-29.** Both lanes green; the suite got 31% faster
(205s → 142s) because the retry loops it no longer runs were pure waiting.

One decision was overturned by measurement. The leading theory for the reproduced failure —
`pglite-socket` connections queuing against `maxConnections: 30` — is **wrong**: instrumenting
`server.getStats()` after every test in the file showed `activeConnections` back to **0** every
time. What did accumulate was tables (2 per test, 22 by the last one), which Phase 5 now drops.
So the file's own comment blaming "the shared PGLiteSocketServer's accumulated load" was a
plausible guess that does not survive checking, and the remaining cause for that test is the
machine plus the tight 10 ms poll — which the Phase 1 backoff addresses directly.

Consequently the plan's "bring the 16 s budget back to honest" was **not done, deliberately**.
The budget was never the problem; tightening it would manufacture failures on a machine that is
permanently contended. The ceilings stay wide, and they now carry labels so a timeout says what
it was waiting for.

Phase 2 also grew one item the plan did not anticipate. Sequencing the personal-channel subscribe
ahead of `presence.set` broke `rabbitmq-presence`: `addRoom` read-modify-writes the descriptor and
silently no-ops when it is absent, so a room joined inside the new window vanished. Presence writes
for a connection are now ordered on `conn.registered` — a real ordering constraint the old code
satisfied only by accident.

## What the investigation established

### The flake is real and measurable

Six consecutive `pnpm test` runs on an otherwise idle machine:

| Run | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| Result | pass | pass | **FAIL** | pass | pass | pass |

**1 failure in 6 full runs — 17%.** Duration swung 2m43s → 3m35s across passing runs.

The failure:

```
FAIL packages/collections-crdt-pglite/test/collections-crdt-pglite.test.ts
  > compaction + materialized snapshot > folds the op-log into <table>.data and trims to a baseline
Error: waitFor timeout                                              16663ms
```

Two things about it matter more than the failure itself:

- **It uses no Docker.** It is in-process PGlite — WASM Postgres on the test's own thread. The
  Docker lane was the wrong place to look.
- **Its budget was already absurd and still lost.** It waits on a **60 ms** debounce, was given
  **16,000 ms**, and timed out at 16,663 ms. A ~250× margin. No amount of raising ceilings fixes
  this class, which rules out the obvious first answer.

### The machine is a permanent, bursty thief

Docker Desktop is allocated **4 CPUs** on a **10-core** host. Sampling container CPU 12× with no
tests running:

| Container | Age | CPU | RAM |
|---|---|---|---|
| `omma-control-plane` (kind Kubernetes) | 14 h | **16% → 137%**, mean ≈ 45% | 7.87 GiB |
| test-owned redis / rabbitmq / ryuk | — | < 1% each | 120 MiB |

A kind control plane bursting to 137% of a CPU — 34% of the whole VM — at random, permanently.
Docker Desktop's VM is a host process, so those bursts steal cores from the Node test forks too,
not just from the brokers. **This was confirmed as a permanent fixture of the dev machine**, so
the suite has to tolerate it rather than wish it away.

That explains the shape of the symptom exactly: flake probability is a function of exposure time,
so one file is safe and a 3½-minute suite is not.

### The suite converts that jitter into failures

| Finding | Detail |
|---|---|
| **24 duplicate `waitFor` implementations** | Defaults spanning **1,000 – 20,000 ms**. Every one throws a context-free `'waitFor timeout'`. |
| **333 of 378 call sites take a 2 s default** | Against `testTimeout: 20_000`. The real budget is 10× tighter than the config suggests. |
| **Tight polls starve what they wait on** | The failing predicate polls every **10 ms**, issuing a WASM SQL query each time — ~1,600 queries in 16 s, competing with the compaction they wait for. |
| **Fixtures degrade across a file** | One central PGlite + one `PGLiteSocketServer` (`maxConnections: 30`) shared by 11 tests; `crdt_0…crdt_10` tables never dropped; **the heaviest test runs last**. The file's own comment already blames "the shared PGLiteSocketServer's accumulated load". |
| **28 retry-until-it-lands loops** | Hard 5 s ceilings (50 × `tick(100)`) that no shared helper can raise. Plus 61 fixed sleeps. |
| **Teardown drops cleanups on first throw** | `for (const fn of cleanups.splice(0)) await fn()` — `splice` empties the array first, so one throwing cleanup **permanently loses** every remaining server/client teardown. |
| **`srv.close()` has an unguarded await** | `await adapter.presence?.clearNode()` precedes `adapter.close()` and `transport.stop()`. A broker hiccup there leaks the adapter *and* the HTTP listener, then trips the cascade above. |
| **Inverted timeout ladder** | `hookTimeout` is the unset default **10 s** — *below* `testTimeout: 20 s` — for files whose `beforeAll` boots libp2p meshes and PGlite. |
| **14 blocking `execSync('docker info')`** | At module top level, ~0.3 s each — ~4.2 s and 14 daemon round-trips per run, while containers are live. |

### The structural gap: the server never says "ready"

Auditing every `void`-discarded promise in `packages/server/src` found that four public surfaces
throw away an establishment promise the caller needs:

| Site | Public method | Discards | Consequence |
|---|---|---|---|
| `index.ts:1350` | `room(n).add(conn)` | `adapter.subscribe` | a broadcast races the subscribe |
| `index.ts:1651` | `srv.subscribe(topic, h)` | `adapter.subscribe` | a cluster-bus publish races the subscribe |
| `index.ts:1443` | `PluginChannel.subscribe(h)` | `adapter.subscribe` | same, for every plugin author |
| `index.ts:820`, `:1204` | `createSuperLineServer(…)` | `adapter.subscribe(replyChannel)`, `transport.start(…)` | the server can return before it is listening |

The last is a real production bug, not only a test problem: `ServerTransport.start` is declared
`void | Promise<void>` and **`libp2pServerTransport.start` is genuinely `async`** — it awaits
`node.handle(protocol, …)`. That promise is discarded, so a libp2p-transported server is not
guaranteed to be handling its protocol when the constructor returns.

A fifth site is the same race with a different shape — `acceptConn` announces a connection to the
cluster *before* subscribing the channels that make it reachable:

```ts
void adapter.presence?.set(descriptor)      // announces the conn cluster-wide…
emitTap({ type: 'connect', descriptor })
void joinChannel(conn, CONN + conn.id)      // …before its personal channel is subscribed
if (uid !== undefined) void joinChannel(conn, USER + uid)
```

Another node reads presence, immediately calls `toConn(id).emit()`, publishes to `c:<id>` — which
nobody has subscribed yet. Lost.

**These loops are not test sloppiness; they are the only thing a caller can do.**
`redis-cross-node.integration.test.ts:76` documents it verbatim: *"room.add subscribes the redis
channel fire-and-forget (no ack); retry the broadcast until it lands."*

### Why this reads as an oversight rather than a design choice

`ready` is a first-class, systematically applied convention on the **client** and completely
absent from the **server**:

| Client surface | Its own doc comment |
|---|---|
| `Subscription.ready` | "Resolves when the server acknowledges the subscribe" |
| `EnvHandle.ready` | "**Kills the connect-time race**" |
| `CollectionSub.ready` | "Resolves once the initial snapshot has been applied" |
| `DocHandle.ready` | "Resolves once the catch-up snapshot has been applied" |

Four on the client, zero on the server. Whoever built the client half solved this problem class
deliberately. The server half never got the same pass.

### Correctly fire-and-forget — audited, and deliberately left alone

`adapter.publish` (at-most-once by design), `presence.beat/set/del/addRoom/removeRoom`
(best-effort telemetry — awaiting buys a caller nothing), `adapter.unsubscribe` (a late
unsubscribe leaks a little traffic and loses nothing), `store.apply`/`store.delete` on the
collections receive path (the frame has already arrived), and the
`void Promise.resolve(handler(…)).catch(…)` hook wrappers (deliberate isolation).

## Root cause

Two independent causes that compound. Neither alone is fatal.

```
┌─ MACHINE (permanent) ─────────────────────────────────────────┐
│  4-CPU Docker VM on a 10-core host; a kind control plane      │
│  bursts 16% → 137% of a CPU at random, 24/7, stealing host    │
│  cores from the Node forks as well as from the brokers.       │
└───────────────────────────────────────────────────────────────┘
                            ╳ compounds with
┌─ SUITE ───────────────────────────────────────────────────────┐
│  a. tight polls that starve the work they wait on             │
│  b. fixtures that degrade across a file, heaviest test last   │
│  c. hard ceilings that exist only because the server offers   │
│     no readiness signal                                       │
│  d. teardown that drops the rest of its work on first throw   │
└───────────────────────────────────────────────────────────────┘
```

## Decisions taken

| # | Decision | Chosen |
|---|---|---|
| D1 | Is the contended machine permanent? | **Yes — harden the suite** rather than assume a quiet one |
| D2 | How to harden a wait that already has a 250× margin | **Fix the wait mechanism** — one helper, backoff, labels. Not bigger numbers, not a library flush hook, not lane isolation |
| D3 | Is library code in scope? | **Yes** — the discarded promises are the root cause, not a test inconvenience |
| D4 | How much fixture isolation to buy | **Drop per-test tables** and assert connections return to baseline. Escalate to a fresh host per test only if the flake survives |
| D5 | How far to take the readiness fix | **All four surfaces plus the `acceptConn` ordering** — finish the convention rather than patch one instance |
| D6 | How to verify | **By hand** — re-run the same 6× loop. The durable diagnostic is the labelled `waitFor`, not a new tool to remember |

### Rejected, and why

- **Raising timeouts.** The reproduced failure had a 250× margin and lost anyway.
- **`vitest retry`.** Unanimously condemned in the research: it reports the last attempt, so a
  genuine race that fails once and passes once is reported green.
- **Redis per-file namespacing (`VITEST_POOL_ID`).** The standard answer, and inapplicable here:
  the lane is serial, so the key collisions it guards against cannot occur. The only reachable
  leak is the 90 s `presenceTtlMs` surviving an ungraceful exit, which Phase 4 makes far less
  likely. Mechanism for an impossible problem. Revisit if the lane is ever parallelised.
- **A `pnpm test:flake` script / CI.** A shell loop already does the former. The latter is a
  separate problem — four connection-rejection tests already fail on a clean Linux runner.
- **A library `flushCompaction()` hook.** Production API whose only consumer is a test.

## Architecture

### The readiness convention

Three shapes, because the three surfaces return different things. All non-breaking.

```ts
// 1. returns nothing today → return the promise. Callers ignoring it are unaffected.
room(name: string): { add(conn: Conn): void | Promise<void>; … }

// 2. already returns an unsubscribe fn → hang `ready` off it. A function is an object.
const unsub = srv.subscribe('announce', cb)
await unsub.ready
const unsub = ctx.channel('watchers').subscribe(cb)
await unsub.ready

// 3. constructor is sync → a new member covering everything it fires off.
const srv = createSuperLineServer(contract, opts)
await srv.ready          // adapter.subscribe(replyChannel) + every transport.start()
```

`srv.ready` must settle even when a transport's `start` rejects — it surfaces the failure rather
than hanging, and rejects rather than swallowing.

### The one wait

One implementation in `packages/server/test/harness.ts`, replacing 24. Backward compatible with
the existing positional-number argument so the 378 call sites do not churn:

```ts
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts?: number | { timeout?: number; label?: string },
): Promise<void>
```

- **Backoff**: poll at 5 ms, double, cap at 250 ms. On a healthy run the predicate settles on the
  first or second poll, so nothing gets slower — the change is invisible except under starvation,
  which is exactly where the tight poll was doing harm.
- **Labels**: on timeout, `waitFor timed out after 16.0s waiting for: <label>`. Vitest already
  prints the caller's file:line, so the label carries the *condition*, which is the part a stack
  trace cannot recover.
- Labels go on the heavy lane and the known-flaky sites, not all 378. The rest inherit backoff and
  the improved message for free.

`packages/server/test/harness.ts` is already the de-facto cross-package test kit — imported by 55
files across core, plugin-auth, plugin-chat and server — and `core/test/collection-store-conformance.js`
is imported the same way by three collections packages. No new package; the pglite suites import
it by relative path like everything else.

### Fixture reset

```ts
cleanups.push(async () => {
  await store.close?.()
  await db.close()
  await host.exec(`DROP TABLE IF EXISTS "${table}", "${table}_updates"`)
})
```

Plus an assertion that the socket server's live connection count returns to baseline between
tests. That confirms or kills the leading theory for the specific stall — `pglite-socket` exports
a `CONNECTION_QUEUE_TIMEOUT`, and 11 stores against `maxConnections: 30` may leave the last test
queuing for a connection rather than computing. Either way the answer is recorded rather than
guessed, and if the flake survives this we know the remaining cause is purely the machine.

## Phases

Each phase ends green (`pnpm typecheck`, `pnpm lint`, both lanes) before the next begins.

### Phase 0 — Vocabulary

`CONTEXT.md` gains **Readiness**: the moment a declared interest — a room membership, a bus
subscription, a plugin channel, a listening transport — is actually *established on the wire*, as
opposed to merely requested. Written first, because the rest of the plan is named after it.

### Phase 1 — One wait

Shared `waitFor` in `harness.ts` with backoff and labels. Delete the 24 local implementations,
importing the shared one. Preserve each site's intended budget where it was deliberate
(`25_000` under a `vi.setConfig({ testTimeout: 30_000 })`, the pglite suites' 15 s).

Verification: both lanes green, and total wall-clock unchanged — backoff must not slow a healthy
run.

### Phase 2 — Readiness on the server

`room.add` returns its promise; `srv.subscribe` and `PluginChannel.subscribe` gain `.ready`;
`srv.ready` covers the reply channel and every `transport.start()`; `acceptConn` subscribes
`c:<id>` / `u:<uid>` before `presence.set` announces the connection.

Each gets a regression test **verified to fail without the fix** — the discipline the traffic-lab
work used, and the only thing that proves a race test tests the race.

### Phase 3 — Teardown that cannot cascade

`dispose()` runs every cleanup and throws an aggregate at the end, so one failure cannot silently
drop the rest. `srv.close()` guards `clearNode` so `adapter.close()` and `transport.stop()` always
run.

### Phase 4 — Delete the retry loops

Room, bus and plugin-channel races become `await …ready` then a single publish. Genuine
slow-joiner races — gossipsub mesh formation, ZeroMQ's PUB/SUB handshake — have no ack to await
and stay as action-in-predicate waits, the idiom
`libp2p-discovery.integration.test.ts:47` already uses.

### Phase 5 — Fixture reset

Per-test table drops and the connection-count assertion in both pglite suites. Then bring the
16 s budget down to something honest and record what the connection count actually did.

### Phase 6 — Configuration and cleanup

Explicit `hookTimeout` above `testTimeout`, restoring the ladder *waitFor ceiling < testTimeout <
hookTimeout*. Delete the 14 module-top-level `execSync('docker info')` calls — `globalSetup`
already gates the lane, so a file can skip on a missing injected URL. Fix the stale
"run in parallel worker threads" comment in `zeromq-cluster.integration.test.ts:8` (the lane has
been serial since 2026-07-16).

### Phase 7 — Verify and release

`pnpm typecheck`, `pnpm lint`, then the same 6× `pnpm test` loop for a before/after against the
measured 17%.

**The 6× after-loop did not produce a usable number, and it is worth knowing why.** Runs 1–2 passed
in 2m27s and 3m27s. Run 3 then took **51 minutes**, run 4 **two hours**, runs 5–6 an hour each — with
`prepare` alone reporting 968s, and individual tests reporting 900,000+ ms elapsed while failing on a
20-second timer. A frozen process, not slow code.

The host was at **load average 84 / 125 / 102 on 10 cores** with 644k pageouts: the Docker VM at
3.4 GB RSS, Spotlight indexing, Chrome, and two Claude sessions had put the machine into a paging
spiral. Failures were scattered across unrelated packages and different every run — the signature of
machine starvation, not a regression. Each one passed in isolation afterwards.

Two conclusions:

- **Running `pnpm test` six times back to back on this machine is itself harmful.** The loop caused
  the state it was trying to measure. A flake rate has to be gathered when the box is quiet, or on
  another box.
- **The 17% → ? comparison is unmeasured**, and should not be claimed. What is measured: both lanes
  green on a settled machine, and wall-clock down from 205s to ~167s (fast 40s, heavy 126s) — the
  retry loops it no longer runs were pure waiting.

The loop did surface one real defect the quiet runs never showed: **`httpServer.close()` waits for
every open connection**, so a long-lived SSE response or a half-closed socket hangs teardown until
the hook timeout. `closeAllConnections()` now precedes `close()` in the harness, `http-compose`, and
the three Control Center sites — teardown is bounded rather than hopeful. Raising `hookTimeout` to
60s had made that hang 6× more expensive to hit, which is how it became visible at all.

`@super-line/server` changed public surface, so it is a release: version bump, `chore(release):`
changelog stamp, tag, and `skills/super-line/` updated across **all four** files.

## Deliberately out of scope

- **plugin-inspector's 2 s watcher keepalive.** It exists partly because `PluginChannel.subscribe`
  offered no way to know the SUBSCRIBE had landed, so `.ready` may make it reducible — but that is
  a hypothesis, and the keepalive also covers broker restarts. Needs its own evidence.
- **The hardcoded ports.** `5601`/`5602` are ugly but forced: `PGLiteSocketServer` takes
  `port?: number` and keeps it private, with no bind-`:0`-and-read-back API. `35672` in
  `rabbitmq-reconnect` is correct and documented — testcontainers reassigns an ephemeral host port
  on `restart()`, which would strand the adapters mid-test.
- **F3**, the libp2p single-topic problem — still the open item from `PLAN-traffic-lab.md`.

## Open questions

**The flake rate is unmeasured after the change.** See Phase 7: the verification loop drove the host
into a paging spiral and measured that instead. Re-run `pnpm test` 6× on a quiet machine — nothing
else heavy running, ideally the kind cluster stopped for the duration — to get a number comparable
to the 17% baseline.

**Does the reproduced failure survive?** Unknown for the same reason. If it does, the remaining cause
is the machine, and D4 escalates to a fresh PGlite host per test — roughly +10 s on the lane's
second-slowest file. The plan deliberately does not pay that cost on a hypothesis.

**`hookTimeout: 60_000` may be too generous.** Its stated purpose — heavy `beforeAll` container boots
— turns out to be handled locally: the pglite suites already pass their own `180_000`/`240_000`. The
global value only really covers libp2p node creation, and its cost is that any hanging hook now burns
a full minute. 30s would be ample. Left at 60s because the teardown fix removed the hang that made it
expensive, but it is worth revisiting rather than inheriting.
