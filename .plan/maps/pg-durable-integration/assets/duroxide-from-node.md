# duroxide from Node — hands-on fit analysis

Resolution asset for the duroxide-from-Node ticket. Maturity was already settled
by the deep-dive ([duroxide-notes.md](duroxide-notes.md)); this session ran the
real package. Verdict up front: **viable, not a dead-end** — the extension-free
path works exactly as advertised, with Preview-grade rough edges observed
first-hand.

## What was run (2026-08-07)

`npm install duroxide` (0.1.28) in a scratch project on macOS/arm64 — prebuilt
napi binary, installs in seconds, no toolchain. A worker-shaped orchestration —
flaky activity under a retry policy → durable timer → two-activity fan-out via
`ctx.all()` — ran to `Completed` on **both** providers:

- `SqliteProvider.inMemory()` — 1.4s wall.
- `PostgresProvider.connectWithSchema('postgresql://…@localhost:54517/postgres', 'sl_workflows')`
  — **the ticket-02 pg_durable eval container** — 1.6s wall.

The retry policy was honored (attempts 1–2 failed, logged
`attempt N/5 failed … Retrying`, attempt 3 succeeded). Structured Rust tracing
lands on stderr by default.

## Coexistence with pgliteCollections-style tables: zero ceremony

`connectWithSchema` created duroxide's 10-table state domain in its own schema,
beside the extension's domains, all in one database:

```
df           ← pg_durable's app-level tables
_duroxide    ← the extension's embedded runtime state
sl_workflows ← duroxide-node's state (instances, executions, history,
               orchestrator_queue, worker_queue, instance_locks, sessions,
               kv_store, kv_delta, _duroxide_migrations)
public       ← where col_* tables would live
```

pg_durable kept completing workflows alongside (`df.start` smoke →
`completed`). Schema-per-consumer is the intended isolation model (the API doc
says "for tenant isolation"). The standing caveat from the deep-dive is
operational, not functional: duroxide's migration runner self-manages its
schema at startup — a **second migration system** in the host's database, with
known (open) first-boot race issues under concurrent multi-node startup.

## The worker-as-activity sketch (ran verbatim, trimmed)

```js
const { PostgresProvider, Runtime, Client } = require('duroxide')

const rt = new Runtime(provider)
// A plugin-queue worker body becomes an activity — plain async TS, unconstrained:
rt.registerActivity('sendEmail', async (actx, input) => {
  // AbortSignal shim: actx.isCancelled() is a poll, our workers take a signal
  const c = new AbortController()
  const poll = setInterval(() => { if (actx.isCancelled()) c.abort() }, 250)
  try { return await sendEmailWorker(input, { signal: c.signal }) }
  finally { clearInterval(poll) }
})
// ONE generic generator wraps any single-activity job — workers never see generators:
rt.registerOrchestration('jobWrapper', function* (ctx, input) {
  return yield ctx.scheduleActivityWithRetry('sendEmail', input,
    { maxAttempts: 5, timeoutMs: 10_000, backoff: 'exponential' })
})
await rt.start()
await new Client(provider).startOrchestration(jobId, 'jobWrapper', payload)
```

Multi-step jobs are where the model pays: more yields (timers, fan-out via
`ctx.all`, signals via `waitForEvent`/`dequeueEvent`, sub-orchestrations),
each step checkpointed — a crash resumes after the last completed step.

## Contract fit

- **The existing worker contract transfers unchanged.** Activities are plain
  async functions with the same demands plugin-queue already makes: at-least-once,
  idempotent, cooperative cancellation. The generator/determinism constraint
  (no `await`, no `Date.now`/`Math.random` — `ctx.utcNow()`/`ctx.newGuid()`)
  lands **only on orchestration authors**; for a queue-shaped shim that's one
  ~10-line reusable generator.
- **Cancellation** maps via a trivial poll→AbortController shim (above);
  `client.cancelInstance()` cascades to children.
- **Retry divergences** stand as catalogued in
  [queue-machinery-mapping.md](queue-machinery-mapping.md) (no jitter, no
  permanent-error class, timeout ≠ retryable). Node-specific: `timeoutMs` is
  **required** on `RetryPolicy`.
- **`WorkerContext` mapping**: `jobId` ↔ `instanceId`; `attempt` is not exposed
  to activities (visible in orchestration logs only) — would ride in the input
  payload if workers need it.

## Rough edges observed (Preview is earned)

- **Typings bug**: `lib/duroxide.d.ts` declares `RetryPolicy.backoff?: number`;
  the engine requires a **string** (`'exponential'` per the user guide — the
  only documented value). A number fails at runtime with the misleading error
  `Invalid generator step result: invalid type: integer, expected a string`,
  failing the whole orchestration.
- The in-memory SQLite provider emits recurring transient
  `database is deadlocked` warnings (self-recovering, retryable) — noisy but
  harmless; the Postgres provider showed none.
- Instance ids are caller-chosen with no documented collision behavior surfaced
  in types; the deep-dive notes an open bug where a sub-orchestration id
  collision hangs the parent silently.

## Answers to the ticket's three questions

1. **Worker as activity**: yes, sketched and executed; workers stay plain TS.
2. **Replay vs worker contract**: compose cleanly; determinism cost isolated to
   one shim orchestration.
3. **Schema coexistence with pgliteCollections tables**: yes, zero ceremony,
   verified live in the eval container — with the second-migration-runner
   operational caveat.
