# ADR-0018: super-line's logging is app-configured (LogTape), not a per-instance option

- Status: Accepted
- Date: 2026-07-24
- Origin: a `/grilling` session on adopting LogTape (see `PLAN-logtape.md`)

## Context

super-line had almost no operational logging (~10 `console.*` calls) and no way for a user to see the
library's internals while debugging their app. The obvious request was a `logLevel` option on
`createSuperLineServer` / `createSuperLineClient` — the winston/pino per-instance model.

We adopted [LogTape](https://logtape.org/) instead, and its design makes a per-instance `logLevel`
**unworkable**, verified against the docs and the package source:

- Libraries must **never** call `configure()` (`library.md`: *"Don't `configure()` LogTape in your library."*).
- Configuration is a **single process-global registry** — `configure()` mutates the logger tree stored at
  `globalThis[Symbol.for("logtape.rootLogger")]`; only one config is active, and re-`configure()` *replaces*
  rather than merges.
- There is **no public API to set a logger's level per-instance** without `configure()`.

super-line constructs **many server/client instances per process** — the test harness spins up a fleet, and
cluster examples run multiple nodes. A `logLevel` that configured LogTape would have the second instance
clobber the first's config, and would fight a host application that configures LogTape for its own code.

## Decision

**Logging is configured by the application, not by super-line's constructors.**

1. super-line packages **only call `getLogger(['super-line', <pkg>, <subsystem>])`** and emit structured
   records. They never configure LogTape.
2. The **application** turns logging on — either via its own `configure()` with a `['super-line']` logger
   entry, or via a super-line convenience helper, **`enableSuperLineLogging({ level, redact })`**, exported
   from `@super-line/core`. The helper is app-level sugar over `configureSync()` (a pretty console sink,
   redaction on by default); it is emphatically *not* called from within `createSuperLineServer`/
   `createSuperLineClient`.
3. Because `configure()` is a single global registry, the helper and a host's own `configure()` are
   **mutually exclusive** — documented, not worked around. A host managing LogTape adds the `['super-line']`
   entry to its own config.

Logging is **silent unless configured** (an unconfigured root logger has no sinks), so this is zero runtime
cost and zero test noise by default.

## Consequences

- A user debugging a reconnect storm, a silently-deaf subscription, or an auth degrade-to-guest can flip
  `enableSuperLineLogging({ level: 'debug' })` (or trace one subsystem) and see super-line's internal
  timeline — the "better debugging" goal — without any per-instance option.
- The absence of a `logLevel` constructor option is deliberate and will surprise anyone expecting the
  winston/pino shape; this ADR is the record of why (single global registry + the no-configure-in-libraries
  rule + many instances per process).
- LogTape can be a normal `dependencies` entry despite super-line's own duplicate-copy caution (core/client
  `instanceof`): LogTape's registry is a global symbol, so duplicated copies share one tree.
- Complementary to, not a replacement for, the existing `TapEvent`/inspector/Control-Center system — that
  observes **wire traffic**; LogTape observes **internal diagnostics**. No bridge between them.
