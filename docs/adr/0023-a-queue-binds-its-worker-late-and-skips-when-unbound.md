# ADR-0023: A queue binds its worker late, and an unbound queue is skipped rather than failed

- Status: Accepted
- Date: 2026-07-28

## Context

`queue({ queues })` required a `worker` on every queue definition. That looks like a local
choice about one field, but it fixes *where the worker's source file may live*: the kit must be
constructed before `defineContract` (it contributes a contract fragment) and before
`createSuperLineServer` (it contributes the plugin), so the declaration necessarily sits wherever
the contract sits — and a required `worker` dragged the implementation along with it.

For any host that keeps its contract in a package shared with other processes, that is a cycle.
The shared package must import the server package to name the worker; the server package already
imports the shared package for the contract. Neither an inline dynamic `import()` nor a hoisted
`let server` fixes it — the dependency is real, it is just written in the wrong direction. The
worker belongs to the server; only its *signature* belongs to the contract.

## Decision

**`worker` becomes optional, and a queue's worker can be bound after the kit exists.**

`kit.queue(name)` returns a `QueueHandle` — the per-queue namespace, carrying `setWorker`,
`hasWorker`, `enqueue`, a queue-scoped `list`, and queue-scoped `schedules.create`/`list`.
Operations keyed by *job id* (`get`/`cancel`/`retry`) stay on the kit, because scoping them to a
queue would either cost an extra read to reject a foreign id or silently lie about the scope. The
resolution order is `bound.get(name) ?? definition.worker`, so an inline `worker:` is a default
and the last `setWorker` wins; nothing mutates the caller's `queues` object.

**A queue with no worker on this node is skipped at claim time.** Its jobs stay `queued`. Three
alternatives were weighed:

- **Fail the job.** Loud, and wrong twice: during the window between mount and `setWorker` it
  would poison anything already enqueued, and on a cluster a node that never binds `report` would
  burn jobs a node that *did* bind it was about to run.
- **Make binding total at compile time** by turning `plugin` into `plugin(workers)` — the mount
  site already lives in the server package, so a missing worker becomes a type error and no
  unbound moment ever exists. Rejected because it forecloses binding after construction, which is
  the point, and because it forces a node that only enqueues to supply stub workers.
- **Loader thunks** resolved on first job. Real code-splitting, but it needs per-queue load state
  and an answer for what a failed import does to the job — machinery beyond the problem, since a
  caller who can bind late can `await import()` first and bind a plain function.

Claiming is the only thing gated on a worker. **Reaping and cron stay unconditional**: a node
that bound nothing still recovers leases expired by a dead peer and still advances schedules into
jobs. That is what makes a pure-enqueue node safe to run.

## Consequences

Split topology falls out without being designed: a node claims exactly the queues it bound, so a
process that binds nothing enqueues and observes while its peers execute. Cluster-wide concurrency
is unaffected, since slots are shared rows keyed `${queue}:${index}`.

The cost is the failure mode we accepted in exchange. A forgotten `setWorker` is indistinguishable
from a queue whose worker lives elsewhere: jobs accumulate in `queued` with nothing logged. The
pile is visible via `kit.list()` and the Control Center's Queues view, and `handle.hasWorker` lets
a host assert its own bindings at boot — but the runtime cannot tell the two cases apart and does
not try. A cron schedule on a queue nobody ever binds compounds this: queued jobs are only stamped
with `deleteAt` once terminal, so with `overlapPolicy: 'allow'` they accumulate indefinitely.

`worker` cannot become required again without a breaking change.
