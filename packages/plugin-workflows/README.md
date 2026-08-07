# @super-line/plugin-workflows

Durable multi-step workflows and queues for super-line, backed by
[duroxide](https://github.com/microsoft/duroxide-node) — a deterministic-replay
durable-execution engine for Node.js.

> **Private pre-release.** This package is not published. duroxide is Preview
> software with weekly releases; the kit stays in-repo until the engine and a
> real consumer harden it. Do not depend on it outside this repository.

## What it is

A paired plugin in the `queue()`/`auth()`/`chat()` family, in two layers:

- **Workflow kit** — plain-async activities plus generator orchestrations
  (`function*`/`yield`, never `async`). Orchestrations survive process crashes:
  completed steps replay from checkpoints; only remaining work re-executes.
  Durable timers, fan-out/fan-in, cancellation, and durable signals
  (buffered event queues) are engine primitives.
- **Thin queue** — a queue-shaped surface (`kit.queue(n).enqueue()`) whose
  workers keep the plugin-queue contract `(input, { signal })`. Each job is a
  single-activity orchestration with engine-side retry.

Lifecycle lands in a `workflowRuns` collection on the contract
(`id · kind · name · status · customStatus · output · timestamps`), so runs are
observable through ordinary collection subscriptions and the Control Center —
deny-all by default; expose them through host-owned requests.

It does **not** replace `@super-line/plugin-queue`. For single-step background
jobs, plugin-queue has the richer queue semantics (priority, jitter, permanent
errors, schedules, cluster slots). This kit starts paying off when work is
multi-step: checkpoints between steps, durable timers, human-in-the-loop
signals.

## Usage

```ts
import { PostgresProvider } from 'duroxide'
import { workflows } from '@super-line/plugin-workflows'

const provider = await PostgresProvider.connectWithSchema(DATABASE_URL, 'my_app_wf')

const kit = workflows({
  provider,
  activities: {
    fetchRows: async ({ table }, { signal }) => {/* ... */},
  },
  workflows: {
    reportPipeline: function* (ctx, input) {
      ctx.setCustomStatus('fetching')
      const rows = yield ctx.scheduleActivity('fetchRows', { table: 'events' })
      yield ctx.scheduleTimer(60_000) // durable — survives restarts
      return { rows }
    },
  },
  queues: {
    sendEmail: {
      worker: async ({ to }, { signal }) => {/* ... */},
      maxAttempts: 3,
      timeoutMs: 10_000,
    },
  },
})

const contract = defineContract({ roles: { user: {} }, plugins: [kit.contract] })
const server = createSuperLineServer(contract, {
  /* ... */
  plugins: [kit.plugin],
})

await kit.run('reportPipeline', 'wf-report-1', {})
await kit.queue('sendEmail').enqueue({ to: 'someone@example.com' })
```

The host passes an **already-connected** provider — `PostgresProvider`
(schema-per-deployment for isolation) or `SqliteProvider` (single-node,
file-backed or in-memory). The plugin's setup owns the engine runtime: it
starts it, re-arms lifecycle projection for non-terminal instances on boot, and
shuts it down with the server.

## Platforms

duroxide is a native (napi-rs) module with prebuilt binaries for
**darwin-x64 · darwin-arm64 · linux-x64 (glibc) · linux-arm64 (glibc) ·
win32-x64**. On any other platform (including musl/Alpine), `workflows()`
throws at construction with an error naming the platform and the gap — there is
no JS fallback.

## Demos

`scratch/` holds runnable demo scripts (not shipped): `node scratch/demo.mjs`
(crash mid-timer, restart, resume from checkpoint) and `node scratch/demo2.mjs`
(cancellation + durable approval signal). Both run on SQLite — no Docker
needed. Build first: `pnpm --filter @super-line/plugin-workflows build`.
