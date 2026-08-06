# duroxide / duroxide-pg — research notes

Sources fetched live via `curl` against the GitHub REST API, raw.githubusercontent.com, npm registry, and PyPI JSON API on 2026-08-07. No training-data guessing — every claim below is sourced inline.

All four repos live under `github.com/microsoft/`, MIT-licensed, marked **"Preview"**:

| repo | language | stars | pushed_at | latest tag |
|---|---|---|---|---|
| `microsoft/duroxide` | Rust | 194 | 2026-08-01 | v0.1.30 |
| `microsoft/duroxide-pg` | Rust | 44 | 2026-07-31 | v0.1.34 |
| `microsoft/duroxide-node` | JS/Rust (napi-rs) | 33 | 2026-07-29 | v0.1.28 |
| `microsoft/duroxide-python` | Python/Rust (PyO3) | 33 | 2026-07-29 | v0.1.27 |

(Source: `api.github.com/repos/microsoft/{duroxide,duroxide-pg,duroxide-node,duroxide-python}`)

Both `duroxide` and `duroxide-pg` repos were created 2026-02-13 — under 6 months old.

---

## The "duroxide family" (source: duroxide README, `docs/` link, "The Duroxide family" section)

The core README is explicit about the intended architecture — five projects, not one:

- **pg_durable** — PostgreSQL extension; durable functions authored directly in SQL, built on duroxide + duroxide-pg.
- **duroxide** (this repo) — Rust runtime, embed in your own service.
- **duroxide-python** — Python SDK over the duroxide runtime, "author workflows in Python."
- **duroxide-node** — Node.js/TypeScript SDK, "author workflows in JavaScript/TypeScript."
- **duroxide-pg** — the Postgres `Provider` implementation, pluggable into duroxide / duroxide-python / duroxide-node.

This is stated as current architecture, not a roadmap — and it checks out (see "Host-language bindings" below): duroxide-node and duroxide-python are real, published, versioned packages, not placeholders.

---

## duroxide programming model

Source: `README.md`, `docs/execution-model.md`, `docs/durable-futures-internals.md` in `microsoft/duroxide`.

- **Orchestrations** are `async fn(OrchestrationContext, Input) -> Result<Output, String>`. They *coordinate* — no I/O, no side effects.
- **Activities** are the unit of side-effecting work, registered on an `ActivityRegistry`:
  ```rust
  ActivityRegistry::builder()
      .register("Hello", |_ctx: ActivityContext, name: String| async move {
          Ok(format!("Hello, {name}!"))
      })
      .build();
  ```
  Activities are **at-least-once**: a crash mid-execution means the activity is retried; activity code must be idempotent.
- Orchestrations are registered similarly on an `OrchestrationRegistry`, and both registries plus a `Provider` are fed into `runtime::Runtime::start_with_store(...)`. A `Client` (constructed from the same store) starts/queries/signals instances.
- Context API surface (Rust): `ctx.schedule_activity(name, input)`, `ctx.schedule_activity_on_session(name, input, session_id)` (worker/session affinity), `ctx.schedule_timer(duration)`, `ctx.schedule_wait(event_name)` (ephemeral, positional-matched), `ctx.dequeue_event(queue)` / `client.enqueue_event(...)` (durable FIFO mailbox, survives continue-as-new), `ctx.schedule_sub_orchestration(name, input)` / `..._with_id(...)`, `ctx.join(vec![...])` (fan-in, all futures polled every turn, results in input order), `ctx.select2/select3(...)` → `Either2`/`Either3` (race, first-completed wins, loser dropped), `ctx.new_guid()`, `ctx.utcnow()`, `ctx.trace_info/warn/error/debug(...)` (suppressed automatically while `is_replaying`), `ctx.is_cancellation_requested()`, `ctx.version()` (version-guard branching), `ctx.continue_as_new(input)`.
- **Storage-agnostic**: a `Provider` trait backs persistence. `duroxide` ships a built-in SQLite provider (`providers::sqlite::SqliteProvider`, in-memory or file); duroxide-pg supplies the Postgres one; anyone can implement their own (`docs/provider-implementation-guide.md`, `docs/provider-testing-guide.md`).
- Patterns supported out of the box, per README: function chaining, fan-out/fan-in, human-in-the-loop, durable timers (minutes to days, no thread held), saga/compensation, built-in retries with backoff and per-attempt timeout, cooperative cancellation (cascades parent→children), worker specialization via tags (e.g. route to a `gpu` pool), durable per-instance KV store.

## Determinism / replay contract (exact rules)

Source: `docs/durable-futures-internals.md` (835 lines — sections "The Replay Algorithm," "Nondeterminism Detection," "Termination and Cancellation"), `docs/execution-model.md`.

**Mechanism.** Execution proceeds in discrete **turns**: a work item (start / activity-completed / timer-fired / external-event) triggers a turn; the orchestration function is **replayed from the beginning** with the accumulated history fed back in; execution runs until it hits a not-yet-complete await, then the turn ends and new actions (schedule calls emitted this turn) are persisted. There is no continuous polling of the orchestration — it's "polled once per turn," strictly event-driven.

Internally each `schedule_*` call emits an `Action`, gets a **token**, and returns a future that polls a `CompletionResult` keyed by that token:
```rust
pub fn schedule_activity(&self, name: &str, input: &str) -> impl Future<...> {
    let token = inner.emit_action(Action::CallActivity { .. });
    std::future::poll_fn(move |_cx| {
        if let Some(CompletionResult::ActivityOk(s)) = inner.get_result(token) {
            Poll::Ready(Ok(s))
        } else { Poll::Pending }
    })
}
```
On replay, the same schedule calls happen in the same order, tokens are re-bound to the same persisted event IDs, and already-completed ones resolve **instantly** from history without re-running the underlying work.

**The determinism contract** (must hold given the same history):
1. Same operations scheduled, in the same order, every replay.
2. Same decisions from the same inputs/results.
3. No direct system calls inside orchestration code — no `std::time`, no `rand`, no `Uuid::new_v4()`, no raw I/O. Use `ctx.schedule_timer()`, `ctx.new_guid()`, `ctx.utcnow()` instead.
4. Concurrency must go through `ctx.join()` / `ctx.select2()`/`select3()` — **never** `tokio::join!` / `tokio::select!`, because those resolve by wall-clock polling order, not deterministic history order.

**Nondeterminism detection is active, not just documented**: the replay engine validates emitted actions against history and fails the turn with an explicit error (example given: `"expected ActivityA, got ActivityB"`) on a schedule mismatch. Table of common causes/fixes given verbatim in the doc: `Uuid::new_v4()` → use `ctx.new_guid()`; `SystemTime::now()` → `ctx.utc_now()`; `rand::random()` → push randomness into an activity; `tokio::select!` → `ctx.select2()`; changing orchestration code → use version guards (`ctx.version() < "2.0"`); branching on external state → pass state as input instead.

**Cancellation** is cooperative and cascading: `client.cancel_instance(id, reason)` records `OrchestrationCancelRequested`; next turn the engine returns `TurnResult::Cancelled` after replay and records `OrchestrationFailed{details: Cancelled{reason}}`. Cancelling a parent cancels all sub-orchestration children. Activities can poll `ctx.is_cancelled()` for cooperative early-exit.

**External events** (`docs/external-events.md`): matched by name + subscription index, not by ID — the Nth `schedule_wait("X")` in history binds to the Nth `raise_event(..,"X",..)`. Events raised before any subscription exists are **dropped with a warning** (no buffering) — this is why there's a second, durable primitive: **event queues** (`dequeue_event`/`enqueue_event`), which are FIFO, buffer once the orchestration instance exists, and **do survive continue-as-new** (ephemeral `schedule_wait` does not — must re-subscribe after CAN).

**Sub-orchestrations** (`docs/sub-orchestrations.md`): parent history gains `SubOrchestrationScheduled/Completed/Failed{id,...}` events; child `OrchestrationStarted` records `parent_instance`/`parent_id`. Auto-generated child IDs are derived deterministically as `"{parent_instance}::sub::{event_id}"` so replays reproduce the same child ID and dispatch is idempotent (already-completed `id` in parent history ⇒ skip re-dispatch); `schedule_sub_orchestration_with_id` lets the caller fully control the child instance ID (no parent prefix).

## duroxide-pg: schema, work queues, locking, poll vs. LISTEN/NOTIFY

Source: `microsoft/duroxide-pg` `migrations/000{1,5,10,13,14,16,18}*.sql`, `src/provider.rs` (3327 lines), README.

**It is pure poll-based — confirmed no `LISTEN`/`NOTIFY` anywhere in `src/provider.rs`** (`grep -in "listen\|notify"` returns zero matches; only `sleep`/`tokio::time` hits, all in the unrelated Entra-token-refresh background task). Dispatchers poll on an interval (`dispatcher_min_poll_interval`, default 100ms in duroxide core's `RuntimeOptions`, see below) and rely on Postgres row locking, not pub/sub, to coordinate claims.

**Core tables** (migration `0001_initial_schema.sql`, schema-qualified so multi-tenant isolation is just "use a different Postgres schema"):
- `instances(instance_id PK, orchestration_name, orchestration_version, current_execution_id, created_at, updated_at)`
- `executions(instance_id, execution_id, status, output, started_at, completed_at)` — `PRIMARY KEY(instance_id, execution_id)`, supports multi-execution (continue-as-new creates new rows).
- `history(instance_id, execution_id, event_id, event_type, event_data JSON-as-TEXT, created_at)` — append-only, `PRIMARY KEY(instance_id, execution_id, event_id)`.
- `orchestrator_queue(id BIGSERIAL, instance_id, work_item TEXT-JSON, visible_at, lock_token, locked_until BIGINT-ms, created_at)`.
- `worker_queue` — same shape as `orchestrator_queue` (`visible_at` column added later, migration `0005`, to unify delayed-visibility semantics between the two queues).
- `instance_locks(instance_id PK, lock_token, locked_until, locked_at)` — coordinates concurrent dispatchers touching the *same instance* (separate from per-work-item queue locks).
- `_duroxide_migrations(version PK, name, applied_at)`.

Later migrations add: `attempt_count` (0003, poison-message detection), `activity_tags` (0016, worker-tag routing — table + capability filtering, migration 0013), `sessions` (0014, session-affinity routing), `custom_status` (0015), `kv_store` (0018: `kv_store(instance_id, key, value, execution_id)`, `PRIMARY KEY(instance_id,key)`), `get_instance_stats` RPC (0021), deletion/pruning support (0010).

**Claim/locking mechanism** — a plpgsql stored procedure per queue, e.g. `fetch_work_item(p_now_ms, p_lock_timeout_ms)` (migration `0005_add_visible_at_to_worker_queue.sql`, full body captured):
```sql
SELECT q.id INTO v_id FROM worker_queue q
WHERE q.visible_at <= TO_TIMESTAMP(p_now_ms/1000.0)
  AND (q.lock_token IS NULL OR q.locked_until <= p_now_ms)
ORDER BY q.id LIMIT 1
FOR UPDATE OF q SKIP LOCKED;
-- then UPDATE ... SET lock_token = 'lock_'||gen_random_uuid(), locked_until = now+timeout, attempt_count += 1
```
i.e. classic **`SELECT ... FOR UPDATE SKIP LOCKED`** claim pattern with a lease (`locked_until`) and attempt counter for poison-message tracking. `abandon_work_item(lock_token, delay_ms, ignore_attempt)` releases a claim, optionally with a `visible_at` backoff delay (decoupled from `locked_until` since 0005 — cleaner "clear lock, set future visibility" semantics rather than "keep it locked to fake a delay"). Corresponding `enqueue_worker_work`/`get_queue_depths` procs also schema-qualified via `EXECUTE format(...)` (Postgres has no native way to parameterize a schema name, hence the plpgsql `format()` indirection everywhere).

Also confirmed a **known race**: `duroxide` issue #10, "duroxide-pg: concurrent worker startup crashes on migration race condition" (open) and #7 in the same list "PostgresProvider.connectWithSchema races on concurrent first-time startup and fails with pg_namespace_nspname_index duplicate key" (open) — first-boot migration/schema-creation races are a live, acknowledged issue as of this writing.

**Auth**: first-class Microsoft Entra ID (Azure AD) support for Azure Database for PostgreSQL Flexible Server — token acquired at construction, background task refreshes and hot-swaps via `sqlx::Pool::set_connect_options` before expiry; credential chain is `WorkloadIdentityCredential → ManagedIdentityCredential → DeveloperToolsCredential`; connections pinned to `PgSslMode::VerifyFull`, no fallback. `PostgresProvider::new_with_config(ProviderConfig)` (0.1.34, breaking rename) lets callers pick `ApplyAll` vs `VerifyOnly` migration policy.

## Running the runtime from a host app (Rust worker process shape; concurrency model)

Source: README hello-world example, `src/runtime/mod.rs` (`RuntimeOptions`, doc comment block).

```rust
let store = Arc::new(SqliteProvider::new("sqlite:./data.db", None).await?);
let activities = ActivityRegistry::builder().register("Hello", |..| async move {..}).build();
let orchestrations = OrchestrationRegistry::builder().register("HelloWorld", |ctx, name| async move {..}).build();
let rt = runtime::Runtime::start_with_store(store.clone(), activities, orchestrations).await;
let client = Client::new(store);
client.start_orchestration("inst-1", "HelloWorld", "Rust").await?;
client.wait_for_orchestration("inst-1", Duration::from_secs(5)).await?;
rt.shutdown(None).await;
```
It's an **embedded, in-process, single-binary** model — "no separate server to operate," runs on Tokio inside the host process. `Runtime::start_with_store` spawns internal dispatcher tasks (poller loops for the orchestrator queue and the worker queue) that live for the process lifetime; `rt.shutdown(...)` tears them down.

`RuntimeOptions` (defaults, from `src/runtime/mod.rs` doc comments + `Default` impl):
- `dispatcher_min_poll_interval: Duration::from_millis(100)` — polling backoff floor when a queue is idle.
- `orchestration_concurrency: usize = 2` — how many orchestration turns can execute concurrently.
- `worker_concurrency: usize = 8` in the doc example, default `2` in the `Default` impl — how many activities can execute concurrently.
- Session affinity: activities scheduled with `schedule_activity_on_session` route to whichever worker "owns" that session, analogous to network flow affinity; a doc comment notes that *without* an explicit session, all `worker_concurrency` slots share a single identity so any idle slot can pick up the work.

This is a **cooperative multi-tasking, single-process worker pool** — not "one thread per orchestration." Both the orchestration dispatcher and the worker (activity) dispatcher are separately-configurable concurrency pools inside the same Tokio runtime, each polling their respective Postgres/SQLite queue table on the interval above.

## Host-language bindings: what exists today (the critical question)

**Verdict up front: Node.js and Python bindings are real, shipping, and directly confirm the pg_durable README's "author in Rust, Python, or Node" claim — this is not vaporware for those two languages.** No other language bindings exist or are hinted at in open issues.

### Node.js — `duroxide-node` → npm package `duroxide`

- Repo: `github.com/microsoft/duroxide-node`, JS+Rust, 33 stars, pushed 2026-07-29, tag `v0.1.28`.
- **npm**: package name is plain `duroxide` (not `duroxide-node`). Source: `registry.npmjs.org/duroxide` and `registry.npmjs.org/-/v1/search?text=duroxide`.
  - Latest `0.1.28`, published 2026-07-29T18:44:14Z by GitHub Actions (OIDC trusted publisher — `oidc:github`), 27 versions total (`0.1.0` → `0.1.28`).
  - Maintainers: `microsoft1es`, `affandar` (personal npm account, matches the `affandar/duroxide*` personal-fork repos also found in the org search — likely the primary author).
  - Description: *"Durable execution runtime for Node.js, powered by Rust."*
  - Downloads: 376/week, 1,999/month (`api.npmjs.org/downloads/point/last-{week,month}/duroxide`) — small but real, non-zero usage.
  - Homepage/repo links point to `github.com/microsoft/duroxide-node`.
  - A separate third-party package, `pilotswarm-sdk` (6,214 monthly downloads, by the same `affandar` maintainer, keywords include `duroxide`), is built *on top of* `duroxide` for "durable GitHub Copilot SDK agents" — evidence of at least one real downstream consumer.
- **Built with napi-rs** (confirmed: `.agents/skills/napi-interop/SKILL.md` in the repo tree, plus README/architecture doc explicitly say "built with napi-rs"). Prebuilt native binaries published per-platform under `npm/npm/{darwin-arm64,darwin-x64,linux-arm64-gnu,linux-x64-gnu,win32-x64-msvc}/` — i.e. the standard napi-rs "optionalDependencies per target triple" distribution pattern. **No Linux ARM64 npm package is published yet** — open issue #5 "Publish Linux ARM64 native npm package" (the table in the README lists `linux-arm64-gnu` as available, but issue #5 says it's still pending; note the mismatch).
- **Programming model**: orchestrations are **`function*` generators using `yield`**, NOT `async function`/`await`. This is a deliberate, load-bearing design choice, explained at length in `docs/architecture.md` ("Yield vs Await" section): `await` hands control to the JS event loop and the Rust replay engine's `poll_once()` can't intercept/replay through that; generators let Rust drive stepping explicitly (`gen.next(value)` / `gen.throw(err)`) so the same replay-with-cached-results trick from Rust core works in JS. Activities *are* plain `async function`s (they're not replayed, so no constraint). The doc explicitly compares this to Temporal's TypeScript SDK, which instead runs orchestration code in a patched V8 isolate — duroxide-node considered that "too complex" and chose generators instead.
- Interop mechanism (from `docs/architecture.md`, diagram + prose): Rust holds a `JsOrchestrationHandler` per instance; on each turn it calls into JS via napi-rs `ThreadsafeFunction` using `tokio::task::block_in_place()` + `Handle::block_on()` to *synchronously* wait for the JS generator's next step (needed because the replay engine's `poll_once()` drops the handler future after one poll — a bare `call_async` future would get dropped before the JS callback fired). Tracing (`ctx.traceInfo` etc.) and custom-status writes are fire-and-forget side channels via a global `ORCHESTRATION_CTXS` map keyed by instance ID, not part of the yield loop.
- **Parity gap vs. Rust core** (explicitly the *only* fundamental one, per the doc): Rust lets you compose arbitrary multi-step `async {}` blocks with `join()`/`select2()`; the JS generator model's `ctx.all()`/`ctx.race()` only accept single task descriptors (activity/timer/event/sub-orchestration) — a multi-step block must be wrapped as a sub-orchestration first to be raced/joined. `ctx.race()` also currently caps at 2 branches (maps to Rust `select2`).
- Feature surface (README) has parity otherwise: activities, timers, sub-orchestrations, external events, fan-out/fan-in, cooperative cancellation via `ctx.isCancelled()`, custom status, durable event queues, continue-as-new, structured tracing via Rust's `tracing` crate (`RUST_LOG` env var controls it from Node), runtime metrics, per-instance KV store, SQLite and Postgres (incl. Entra ID auth) providers, and a management/admin API (`listAllInstances`, `getInstanceInfo`, `getInstanceTree`, `deleteInstance`, `readExecutionHistory`, `getSystemMetrics`, `getQueueDepths`, etc.).
- Tests: `npm run test:all` = 52 tests (25 PG + 1 SQLite e2e smoketest, 7 race/join, 14 admin API, 6 scenario) — a real, substantial suite, not a toy.

### Python — `duroxide-python` → PyPI package `duroxide`

- Repo: `github.com/microsoft/duroxide-python`, Python+Rust, 33 stars, pushed 2026-07-29, tag `v0.1.27`.
- **PyPI**: package name is plain `duroxide` (confusingly the *same* name as the npm package — different registries, no collision in practice, but worth flagging). Source: `pypi.org/pypi/duroxide/json`.
  - Latest `0.1.27`, `requires_python >= 3.9`, summary *"Python SDK for the Duroxide durable execution runtime."*
  - 25 releases on PyPI (`0.1.0` through `0.1.27`, a couple of version numbers skipped e.g. no 0.1.17/0.1.21/0.1.23).
  - Prebuilt wheels for the 0.1.27 release: macOS x86_64 + arm64, manylinux_2_28 aarch64 + x86_64, Windows amd64 — **all built for `cp312` (Python 3.12) only** despite the `requires_python >= 3.9` classifier — matches open issue #6 "Provide wheels compatible with non-3.12 versions of Python" (i.e., installing on 3.9–3.11 today likely falls back to a source build requiring a Rust toolchain, or fails outright without one).
- **Built with PyO3 + maturin** (confirmed: `.agents/skills/pyo3-interop/SKILL.md` in repo tree, README "Development" section uses `maturin develop`/`maturin build --release`).
- **Programming model**: same generator/`yield` model as Node — regular Python generator functions (`def ...(): yield ...`), NOT `async def`. Activities are **plain synchronous functions** (not even `async def` — different from Node, where activities are `async function`). The doc explains why: activities are invoked via `block_in_place` + `Python::with_gil()` from a tokio thread; users needing async I/O inside an activity are told to call `asyncio.run()` themselves.
- **The GIL deadlock problem — the one Python-specific gotcha not present in Node** (`docs/architecture.md`, dedicated section, code included): PyO3 holds the GIL while Python calls into a `#[pymethods]` Rust function; if that Rust function calls `TOKIO_RT.block_on()`, the calling thread blocks *while holding the GIL*. Meanwhile orchestration/activity handlers running on other tokio threads need the GIL via `Python::with_gil()` to call back into user code — deadlock. **Fix, applied to all 20+ blocking methods in `client.rs`/`runtime.rs`**: every method that calls `block_on` must first call `py.allow_threads(|| { TOKIO_RT.block_on(...) })` to release the GIL before blocking. A secondary wrinkle: `PyErr` isn't `Send`, so errors inside `allow_threads` are mapped to `String` first, then converted back to `PyRuntimeError` outside the closure.
- A single global `static TOKIO_RT: LazyLock<tokio::runtime::Runtime>` backs all async operations — no `pyo3-async-runtimes` dependency, deliberately kept simple per the doc.
- Same parity gap as Node: multi-step `async{}`-block composition isn't directly representable in `ctx.all()`/`ctx.race()`; wrap as a sub-orchestration. `ctx.race()` also caps at 2.
- Feature surface (README) closely mirrors Node: generator orchestrations, sync activities, timers, external events, sub-orchestrations, `ctx.all()`/`ctx.race()`, continue-as-new, SQLite + Postgres (incl. Entra ID) providers, custom status + `client.wait_for_status_change()`, full KV store API (`ctx.set_kv_value`/`get_kv_value`/`get_kv_all_values`/`get_kv_all_keys`/`get_kv_length`/`clear_kv_value`/`clear_all_kv_values`/`prune_kv_values_updated_before`, plus client-side `get_kv_value`/`wait_for_kv_value`), event queues (`ctx.dequeue_event`/`client.enqueue_event`), tag-based worker routing (`MAX_WORKER_TAGS=5`, `MAX_TAG_NAME_BYTES=256`, `MAX_KV_KEYS=150`, `MAX_KV_VALUE_BYTES=65536` — same numeric limits as Node, confirming both bind the same underlying Rust constants), admin APIs, `ctx.get_client()` (activities can start new orchestrations).
- Tests: README says "Run all 59 tests" via `pytest` — again a real suite, comparable in size to Node's 52.

### What does NOT exist

- **No Go, Java, .NET/C#, Ruby, or WASM bindings** found anywhere — not on GitHub (`api.github.com/search/repositories?q=duroxide` returns exactly 13 repos total, all Rust/JS/Python and all either `microsoft/*` or personal forks/experiments by the same author `affandar`), not on crates.io (a `crates.io/api/v1/crates/duroxide` lookup returned a rate-limit/policy error, not data, but the GitHub repo tree shows no `wasm`/`neon` bindings dir), not hinted at in any open issue title across all three core repos (`duroxide`, `duroxide-node`, `duroxide-python` issue lists fully enumerated below).
- No `duroxide-go`, `duroxide-java`, etc. repos exist under the `microsoft` org (only `duroxide`, `duroxide-pg`, `duroxide-node`, `duroxide-python`).
- Two personal (non-Microsoft) satellite projects exist and are worth flagging as *not* official bindings: `mhingston/pi-duroxide` ("a pi extension that integrates duroxide") and `mhingston/lasso` ("runtime harness synthesizer built on pi-duroxide") — third-party, unaffiliated with Microsoft, last pushed 2026-05-21.
- `MoonVision/duroxide-sea` — a third-party **sea-orm** provider implementation (alternative to duroxide-pg), also unaffiliated, pushed 2026-07-31 (recent/active).

## Versions & maturity signals

- All four Microsoft repos are explicitly labeled **"Preview"** in their READMEs (duroxide: *"> **Preview:** This project is currently in preview."*).
- Semver is pre-1.0 across the board: duroxide v0.1.30, duroxide-pg v0.1.34, duroxide-node v0.1.28 (npm `0.1.28`), duroxide-python v0.1.27 (PyPI `0.1.27`) — none has cut a 1.0.
- **Release cadence is very high** — duroxide has gone from v0.1.0 (repo created 2026-02-13) to v0.1.30 by 2026-08-01, i.e. roughly 30 tagged releases in under 6 months (~1 release per week). duroxide-pg is at v0.1.34 over the same window — even faster. Node/Python bindings track close behind core (v0.1.28/v0.1.27 respectively), confirming they're being actively kept in sync, not abandoned after initial publish.
- npm publishing is automated via GitHub Actions with **OIDC trusted publisher** (no long-lived npm token in CI) — a modern, security-conscious release pipeline, another maturity signal.
- Known **breaking changes already shipped** in this short window: duroxide-pg 0.1.34 renamed `PostgresProvider::new_with_config` to take a single `ProviderConfig` (was multiple positional args); Windows npm package was renamed (`duroxide-win32-x64-msvc` → `duroxide-windows-x64`, issue #11, closed) — the "Preview" label is earned; the API is still moving.
- Open, acknowledged **correctness bugs at the time of writing** (not resolved): livelock in orchestration message lock-lease computation (duroxide #46), `Runtime::shutdown` can't stop dispatcher-spawned child tasks (duroxide #44), worker abandons items on retryable ack failures causing redundant re-execution (duroxide #41), explicit sub-orchestration ID collision with a running instance hangs the parent silently (duroxide #40), concurrent first-boot migration/schema races in duroxide-pg (duroxide #10, #7) — i.e. this is genuinely early-stage software with live correctness issues in exactly the areas (locking, replay, migrations) that matter most for a durable-execution runtime.
- Downloads are modest but non-zero and growing a real dependent: `duroxide` npm package sees 376 downloads/week; a third-party package (`pilotswarm-sdk`, 6.2k monthly downloads) depends on it.
- Both `duroxide-node` and `duroxide-python` repos ship an `.agents/skills/` directory (`napi-interop`, `pyo3-interop`, `npm-publish`/`pypi-publish` skill files) — i.e. the maintainers are building this with AI-agent-assisted workflows as a first-class part of their dev process, mirrored in duroxide core's own `.github/skills/duroxide-code-coverage` and `prompts/` directory of Claude/Copilot prompt templates.

## Open questions

- **npm/PyPI package-name collision risk**: both the Node and Python bindings publish under the bare name `duroxide` on their respective registries — not `duroxide-node`/`duroxide-python`. Confirm this is intentional before citing "install duroxide" without registry context, since it's ambiguous in prose.
- **duroxide-node Linux ARM64**: README's provider table lists `duroxide-linux-arm64-gnu` as published, but open issue #5 says it still needs to be published — did not resolve this discrepancy; worth a direct `npm view duroxide-linux-arm64-gnu` check before relying on it.
- **Python wheel Python-version coverage**: only `cp312` wheels are currently built despite `requires_python >= 3.9` — unresolved (issue #6 open); unclear whether 3.9–3.11 users can pip install without a local Rust toolchain today.
- Did not fetch the pg_durable repo itself in this pass (out of scope per the task — it "underpins" pg_durable but the ask was specifically about duroxide/duroxide-pg as directly-embeddable libraries) — if pg_durable's own claims need verifying against its actual source, that's a separate fetch.
- Did not exhaustively diff every migration file (34 in duroxide-pg) — captured the schema-defining and locking-relevant ones (0001, 0005, 0010, 0013, 0014, 0016, 0018); later migrations (0017 "retry orchestration fetch on contention", 0019–0021 KV/version/stats additions) were listed but not opened in full.
- crates.io API returned a policy-violation error for `duroxide`/`duroxide-pg` lookups (`"unable to process your request... in violation of our API data access policy"`) — could not independently confirm crates.io download counts or full version history; the README's crates.io badges (`img.shields.io/crates/v/duroxide.svg`) imply publication but weren't cross-checked against crates.io directly.
- The Rust-core `RuntimeOptions.worker_concurrency` default is stated as `2` in the struct's `Default` impl but the doc-comment example a few lines above shows `worker_concurrency: 8` — these were both directly observed in `src/runtime/mod.rs`; treat `2` as authoritative (it's the `Default` impl) and the `8` as illustrative-only in the doc comment, but flagging the inconsistency since it wasn't explicitly reconciled in-source.

## Sources

- `https://api.github.com/repos/microsoft/duroxide` · `/duroxide-pg` · `/duroxide-node` · `/duroxide-python`
- `https://api.github.com/repos/microsoft/{duroxide,duroxide-pg,duroxide-node,duroxide-python}/git/trees/main?recursive=1`
- `https://api.github.com/repos/microsoft/{duroxide,duroxide-pg,duroxide-node,duroxide-python}/tags?per_page=20`
- `https://api.github.com/repos/microsoft/{duroxide,duroxide-node,duroxide-python}/issues?state=all&per_page=50`
- `https://api.github.com/search/repositories?q=duroxide`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/README.md`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/docs/execution-model.md`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/docs/replay-engine.md` (deprecated stub → durable-futures-internals.md)
- `https://raw.githubusercontent.com/microsoft/duroxide/main/docs/durable-futures-internals.md`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/docs/sub-orchestrations.md`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/docs/external-events.md`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/src/runtime/mod.rs`
- `https://raw.githubusercontent.com/microsoft/duroxide/main/src/runtime/dispatchers/mod.rs`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/README.md`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/src/provider.rs`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0001_initial_schema.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0005_add_visible_at_to_worker_queue.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0010_add_deletion_and_pruning_support.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0013_add_capability_filtering.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0014_add_session_support.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0016_add_activity_tags.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-pg/main/migrations/0018_add_kv_store.sql`
- `https://raw.githubusercontent.com/microsoft/duroxide-node/main/README.md`
- `https://raw.githubusercontent.com/microsoft/duroxide-node/main/docs/architecture.md`
- `https://raw.githubusercontent.com/microsoft/duroxide-node/main/docs/user-guide.md` (fetched, not deeply excerpted above)
- `https://raw.githubusercontent.com/microsoft/duroxide-python/main/README.md`
- `https://raw.githubusercontent.com/microsoft/duroxide-python/main/docs/architecture.md`
- `https://raw.githubusercontent.com/microsoft/duroxide-python/main/docs/user-guide.md` (fetched, not deeply excerpted above)
- `https://registry.npmjs.org/duroxide`
- `https://registry.npmjs.org/-/v1/search?text=duroxide`
- `https://api.npmjs.org/downloads/point/last-week/duroxide` · `last-month/duroxide`
- `https://pypi.org/pypi/duroxide/json`
- `https://crates.io/api/v1/crates/duroxide` (blocked by crates.io API policy — no data obtained)
