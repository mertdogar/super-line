# Schedule periodic queue jobs

Schedules create ordinary jobs using a five-field cron expression.

```ts
await queueKit.schedules.create({
  id: 'weekly-report', queue: 'report', cron: '0 9 * * 1',
  timezone: 'Europe/Berlin', input: { kind: 'weekly' },
  misfirePolicy: 'latest', overlapPolicy: 'skip',
})
```

Use an IANA timezone. A queue-level `timezone` is the default. On a restart, `latest` creates only the newest missed run, `skip` creates only occurrences near the poll window, and `all` creates every missed occurrence up to `maxCatchUp` (default 100). `overlapPolicy: 'skip'` does not create another run while this schedule already has queued or running work.

Operate schedules with `update`, `pause`, `resume`, `trigger`, and `delete`. Generated jobs carry `scheduleId` and `scheduledFor`. Conditional batches make two cluster nodes unable to create the same occurrence. See [Run queues across a cluster](/how-to/queue-clusters) for shared authority.
