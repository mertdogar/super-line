---
type: task
blocked_by: [06]
---
# Test suite and lane placement

## Question

Formalize the scratch harnesses into the kit's real test suite: SQLite-provider
tests where a file DB suffices (fast lane candidates — but mind the native-addon
forks rule), Postgres-provider tests via testcontainers (crash-resume via child
process kill, recovery, cancellation classification, signals, projection rows)
in the **heavy lane** — add the file(s) to the `heavy` list in
`vitest.config.ts`, not just an `.integration.test.ts` suffix. Budgets: both
lanes run serially; keep waits within the conventions the loopback suites use.
`pnpm test` and `pnpm test:integration <name>` both green.

## Done when

Full `pnpm test` passes locally with the new suites in their lanes, and the
crash-resume test demonstrably kills and restarts a real process.

## Answer
