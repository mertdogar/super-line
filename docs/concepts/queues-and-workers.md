# Queues and workers

A queue is durable server-side work, not a client collection feature. The queue plugin persists jobs, schedules, and slots in typed collections, then sets deny-all client policies. Applications choose their own narrow requests to create or observe work.

`queue({ queues })` returns one kit: its `contract` fragment declares the durable model on the application contract and its `plugin` starts workers on a server. Concurrency is configured at construction; there is no mutable concurrency control plane.

A worker is separable from its declaration: bind it inline, or later through `kit.queue(name).setWorker`. Binding is per node, so a node claims exactly the queues it has bound and leaves the rest `queued` for a node that has one — which is why a process that binds nothing can enqueue and observe while its peers execute. Such a node still recovers work abandoned by a dead peer and still turns schedules into jobs; neither is execution.

For concurrency two, the plugin creates two slot rows. A conditional batch claims a ready job and a slot together, recording a fresh `runId`, lease expiry, and owning `nodeKey`. Renewing and settling require that run id, fencing an old worker after a lease has expired and another node has reclaimed its job.

The result is at-least-once execution, not exactly-once execution: an external effect may happen before a crash but before completion persists. Workers must be idempotent.

Postgres shared authority makes claims, cancellation, schedules, and concurrency cluster-wide. An adapter improves wake latency and topology but is not the correctness mechanism. Cron schedules use conditional batches to insert ordinary jobs, so retries, retention, cancellation, and observation work the same way for periodic and ad-hoc work.

See [Add a queue](/how-to/plugin-queue), [Schedule periodic jobs](/how-to/queue-schedules), and [Run queues across a cluster](/how-to/queue-clusters).
