# Enqueue and observe queue jobs

Queue collections are server-only. Expose the operations a browser needs with ordinary Super Line requests; enqueue through `queueKit` in the handler and return a job id or a sanitized summary.

```ts
createReport: async ({ reportId }) => {
  const job = await queueKit.enqueue('report', { reportId }, { priority: 10 })
  return { jobId: job.id }
}
```

`priority` sorts higher values first among ready jobs. `availableAt` delays a job until an epoch-millisecond timestamp. Supplying `id` makes a producer retry safe when the id is an external idempotency key.

For observation, list on the server and map rows to the public shape your UI needs. The browser can poll its own `listJobs` request; do not expose full job, lease, result, or node metadata by default.

```ts
listJobs: async () => (await queueKit.list({
  orderBy: [{ field: 'createdAt', dir: 'desc' }], limit: 50,
})).map(({ id, status, attempt, createdAt, updatedAt, finishedAt, lastError }) => ({
  id, status, attempt, createdAt, updatedAt, finishedAt, error: lastError?.message,
}))
```

`cancel()` immediately terminals queued work; running work receives an abort request and settles cancelled when its worker observes the signal. `retry()` creates a new job from a terminal one. Authorize every public operation against your application’s ownership model. The [`queue-cluster`](https://github.com/mertdogar/super-line/tree/main/examples/queue-cluster) dashboard follows this request-wrapper pattern.
