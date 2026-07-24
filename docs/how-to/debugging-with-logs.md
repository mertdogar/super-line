# Debugging with logs

super-line emits internal diagnostics through [LogTape](https://logtape.org/) — reconnect decisions,
auth resolution, subscribe authorization, stream settle, cluster fan-out. It is **silent by default**: nothing
prints unless your application turns logging on. (This is separate from the [Control
Center inspector](/how-to/control-center), which observes *wire traffic*; logs observe super-line's *internals*.)

## The one-liner

```ts
import { enableSuperLineLogging } from '@super-line/core'

enableSuperLineLogging({ level: 'debug' })
```

That wires a pretty, **secret-redacting** console at the chosen level. Call it once, early. Levels:

- `info` — rare notable events.
- `debug` — lifecycle + decisions (connection accepted/closed, auth resolved/degraded, session created,
  reconnect scheduled, subscribe authorized/denied, stream settle). **Start here.**
- `trace` — the per-message firehose (every request, every published frame, every env update).

```ts
enableSuperLineLogging({ level: 'trace' })       // everything
enableSuperLineLogging({ level: 'debug', redact: false }) // trusted local run, no redaction
```

::: warning One config per process
`enableSuperLineLogging()` calls LogTape's `configureSync()`, which owns a **single process-global**
configuration. Use it **or** your own `configure()`, never both — see below.
:::

## Filter one subsystem

Loggers are categorized `['super-line', <package>, <subsystem>]`, so you can trace just the noisy part while
keeping everything else quiet — but that needs your own `configure()` (the helper sets one level for all of
`['super-line']`):

```ts
import { configure, getConsoleSink } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { redactByField } from '@logtape/redaction'
import { SUPER_LINE_REDACT_FIELDS } from '@super-line/core'

await configure({
  sinks: { console: redactByField(getConsoleSink({ formatter: getPrettyFormatter() }), SUPER_LINE_REDACT_FIELDS) },
  loggers: [
    { category: ['super-line'], lowestLevel: 'info', sinks: ['console'] },
    { category: ['super-line', 'client', 'reconnect'], lowestLevel: 'trace', sinks: ['console'] }, // just reconnects
    { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
  ],
})
```

The subsystems:

| Package | Subsystems |
|---|---|
| `server` | `conn` · `dispatch` · `sub` · `cluster` |
| `client` | `conn` · `reconnect` · `sub` · `env` |
| `plugin-auth` | `authn` · `session` |
| `plugin-chat` | `stream` |

## If your app already uses LogTape

Don't call `enableSuperLineLogging()` — it would replace your configuration. Add a `['super-line']` logger to
your **own** `configure()` instead, and wrap your sink in `redactByField(sink, SUPER_LINE_REDACT_FIELDS)` (or
your own field list) — super-line attaches rich structured context (handshakes, rows) to trace logs, and
redaction is what keeps secrets out of them. `@super-line/core` re-exports `SUPER_LINE_REDACT_FIELDS` as a
sensible default (plaintext passwords, minted tokens/keys, JWTs, credentials, PII email — while letting
identifiers like `authMethod`/`nodeKey` through).

## A global backstop for unhandled errors

super-line is a library, so it deliberately does **not** install `process.on('uncaughtException' | 'unhandledRejection')` — those are process-global and belong to your application (a library grabbing them would fight your own error handling, Sentry, or the test runner). If you want a catch-all for errors that escape your own `try`/`catch` — a rejected `authKit.users.create(...)` you forgot to await, say — add one in **your** app and correlate it with super-line's logs:

```ts
import { enableSuperLineLogging } from '@super-line/core'

enableSuperLineLogging({ level: 'debug' })

process.on('unhandledRejection', (reason) => {
  console.error('[app] unhandled rejection', reason)
})
```

Note this only catches errors that reach the top with no handler. Most super-line throws are already handled — a request handler's throw becomes an error frame to the client, and a rejected `authenticate` is turned into a `401`. That `401` is otherwise silent (the reason never reaches the client), so the WebSocket transport logs a *thrown* auth error at `warning` under `['super-line', 'transport-websocket', 'auth']` — enable logging and a config bug, a nodeKey mistake, or a rejecting `authenticate` hook shows up as `authenticate threw — rejecting connection with 401` instead of a mystery drop. So a global `unhandledRejection` handler is a backstop for **your** code; seeing super-line's internals is what enabling the logs above is for.

## Structured, not stringified

Every super-line log is structured — named placeholders plus a properties object — so a JSON sink
(`getJsonLinesFormatter()`) gives you real fields to query, not a flattened string:

```
super-line.client.reconnect  reconnect scheduled in 500ms (attempt 1)  { ms: 500, attempt: 1 }
super-line.server.conn       connection accepted c-abc role=user via websocket  { connId, role, transport }
super-line.plugin-auth.authn degraded to guest: access token missing or expired  { reason, requestedRole }
```
