# PLAN — LogTape structured logging across super-line

Adopt [LogTape](https://logtape.org/) for internal diagnostic logging so a user debugging their app can see
super-line's internals (reconnect decisions, auth resolution, subscribe authz, stream settle, cluster
fan-out). Settled in a grill-me session 2026-07-24. First pass: **core · server · client · plugin-auth ·
plugin-chat**.

## Why, and the shape it forces

super-line has almost no operational logging today (~10 `console.*` calls, all `warn`/`error` for
exceptional cases) and a rich **wire-traffic** observability system already (the `TapEvent`/inspector/Control
Center path). LogTape fills the *other* gap: **internal library diagnostics** the inspector doesn't cover.

LogTape's model is non-negotiable and was verified against `manual/library.md`, `manual/config.md`, and the
package source:

- **Libraries call `getLogger()` only; never `configure()`.** (`library.md`: *"Don't `configure()` LogTape in
  your library."*) super-line packages emit; the **application** configures.
- **Config is a single process-global registry** (`config.js` mutates the tree at
  `globalThis[Symbol.for("logtape.rootLogger")]`). Only one config is active; re-`configure()` needs
  `reset: true`, which *replaces* — configs don't merge.
- **Unconfigured = silent** (root logger has no sinks → `getLogger().debug()` is a no-op). Zero runtime cost
  and zero test noise unless a user opts in.
- **Duplication-immune**: the registry is a global symbol, so a duplicated `@logtape/logtape` in `node_modules`
  still shares one tree (unlike core/client `instanceof`). → LogTape can be a normal `dependencies` entry.

The consequence for the original ask: a `logLevel` on `createSuperLineServer`/`createSuperLineClient` **cannot
work** — the harness spins up many server instances per process, and the second one configuring would clobber
the first (single global registry), and fight a host app that configures LogTape itself. → ADR-0018.

## Settled decisions

1. **App-configured, not per-instance.** No `logLevel` constructor option. Packages emit via `getLogger()`.

2. **`enableSuperLineLogging(opts?)` — the opt-in app helper**, exported from **main `@super-line/core`**
   (static imports; all three logtape packages are zero-dep and browser-safe — verified: `@logtape/pretty`
   resolves a browser-safe `#util` via export conditions and disables ANSI when `window` is defined;
   `@logtape/redaction` has no node builtins). It wraps `configureSync()`:
   ```ts
   enableSuperLineLogging({ level = 'debug', redact = true } = {})
   ```
   - Level filters the `['super-line']` category.
   - Pretty console sink (`@logtape/pretty` `getPrettyFormatter()`).
   - **Redacts by default** (`@logtape/redaction` `redactByField` — fields
     `password, passwordHash, secret, token, jwt, apiKey, key, upstreamKey, sealed` + `JWT_PATTERN` /
     `EMAIL_ADDRESS_PATTERN`). `redact: false` opts out for trusted local debugging.
   - **Documented constraint**: use this **or** your own `configure()`, never both (single global registry).
     Self-managed users add a `['super-line']` logger entry to their `configure()` and are shown the
     redaction recipe (their responsibility once they own config).

3. **Categories** `['super-line', <pkg>, <subsystem>]` — sub-categorized so a user can trace ONE subsystem:
   | pkg | subsystems |
   |---|---|
   | core | `validate`, `version` |
   | server | `conn`, `auth`, `dispatch`, `sub`, `cluster`, `collections` |
   | client | `conn`, `reconnect`, `sub`, `env` |
   | plugin-auth | `authn`, `session`, `hooks`, `presence` |
   | plugin-chat | `stream`, `hooks`, `resource` |

4. **Level discipline** (super-line is on the per-message hot path):
   - `info` — rare notable events (server bound, cluster peer joined, shutdown).
   - `debug` — lifecycle + decisions (conn accepted/closed, auth resolved/degraded, session created/ended,
     reconnect scheduled, subscribe authz, stream settle).
   - `trace` — per-message/per-frame firehose (inbound request, frame out, collection change, env frame).
   - `warning`/`error` — today's exceptional cases (backpressure drop, dup-copy, resubscribe-failed, swallowed
     hook).

5. **Structured throughout.** Named placeholders + a properties object; never string-concat, never flatten
   rich values into one text blob. Rich objects (handshakes, rows, payloads) MAY be attached as structured
   props — **redaction is the safety net**. One carve-out kept from ADR-0017: a *raw minted token/key/plaintext
   password* is never attached as its own prop even with redaction on (redaction is defense-in-depth, not
   license to log the crown jewel).

6. **LogTape is purely ADDITIVE — existing `console.*` kept.** (Deviation from the original grill decision,
   found during the build.) The existing `console.warn`/`console.error` sites are **loud-by-default safety
   nets**: `core/version.ts` (two copies of core loaded), the client `routeError` resubscribe path (its
   comment: *"Loud by default … otherwise a silently deaf subscription"*), `plugin-auth` `onHookError`
   default, `plugin-chat` resource-card failure. Converting any to opt-in LogTape makes it **silent unless the
   user enables logging** — a visibility regression that reintroduces exactly what these guard against. So they
   stay `console`; LogTape only adds the new `debug`/`trace`/`info` diagnostics + `warning` for genuinely new
   conditions. (Reversible — if a host would rather these route through LogTape, that is a small follow-up.)

7. **Density: moderate** — ~25–35 new structured sites across the five packages (the table in decision 3),
   plus ~10 conversions. Not carpet-bombing every function.

## Instrumentation points (representative)

- **server** — `authenticate` outcome + degrade path (debug); `onConnection`/`onDisconnect` accept/close
  (debug); request dispatch in/reply (trace); subscribe authorize/deny (debug); cluster publish/subscribe
  fan-out (trace) + peer join (info); collection change routed (trace) + drift refuse-to-boot (warning).
- **client** — `connect`/`onOpen`/`onClose` (debug); reconnect scheduled `{ms, attempt}` (debug) + gave-up
  (warning); resubscribe on reconnect (debug) + resubscribe-failed (warning, from today's `routeError`); env
  frame (trace); request timeout (debug).
- **plugin-auth** — each `resolveBase` path (api-key/jwt/token/guest) `{authMethod}` (debug); session
  create/end (debug); swallowed `deactivate.before` (error, from `onHookError`); presence refresh (trace).
- **plugin-chat** — stream settle `{status}`/checkpoint/abort (debug/trace); resource card post failed
  (error); hook veto/error (debug/error).
- **core** — schema validation failure `{path}` (debug); dup-copy (warning, from `version.ts`).

## Dependencies

- `core` += `@logtape/logtape`, `@logtape/pretty`, `@logtape/redaction` (all `2.2.4`, zero-dep, browser-safe).
- `server` · `client` · `plugin-auth` · `plugin-chat` += `@logtape/logtape` only.
- All normal `dependencies` (duplication-immune). Peer-dep gymnastics not needed.

## Phases (TDD; suite stays green — unconfigured logging is silent)

- **Phase 0 — plumbing.** Add the deps; `packages/core/src/log.ts` with `enableSuperLineLogging` + the shared
  redaction defaults; export from core. Test with `@logtape/testing`: helper wires the category at the level;
  redaction strips a token; `redact:false` doesn't. `reset()` in teardown.
- **Phase 1 — server + client.** `getLogger` call sites per the tables. Tests: a recorder sink asserts a
  reconnect log carries structured `{ms, attempt}`; an auth-degrade log fires; secrets are absent from props.
- **Phase 2 — plugin-auth + plugin-chat.** Call sites + convert `onHookError`/resource-card defaults. Tests:
  the swallowed-hook path logs structured `{op}`; an explicit `onHookError` still overrides.
- **Phase 3 — core conversions + docs.** Convert `version.ts`; add validation-failure debug. Write
  `docs/how-to/debugging-with-logs.md` (the helper, the self-managed `configure()` + redaction recipe, the
  category table, the one-config constraint) + nav. README mention.
- **Phase 4 — release.** Minor bumps for the five packages (additive) — deferred to a separate `chore(release)`
  commit per repo convention.

## Follow-up (post-plan additions)

- **`nodeKey` clarity + the swallowed-auth-throw fix.** Sharpened both plugin-auth `nodeKey` error messages to
  explain the session-reconciliation consequence (it throws at construction — a missing `nodeKey` was never
  silent, but a non-stable one leaks sessions). And gave `transport-websocket` **one** log site ahead of the
  broader transport rollout: its `authenticate` `catch` swallows a thrown auth error into a bare 401 — it now
  logs that at `warning` under `['super-line','transport-websocket','auth']` (LogTape, not `console`, so an app
  whose `authenticate` throws per-attempt doesn't flood stderr). `docs/how-to/debugging-with-logs.md` gains an
  app-side `unhandledRejection` backstop recipe (a library must not own process-global handlers). Deps:
  `transport-websocket` += `@logtape/logtape`.

## Explicitly out of scope

- `logLevel` on the constructors (impossible under LogTape's global model — ADR-0018).
- the rest of transports, adapters, collection backends, react (follow later, same pattern).
- Bridging LogTape ↔ the inspector/Tap system — they stay complementary (internal diagnostics vs
  wire-traffic observability). No adapter between them.
- `withContext`/`AsyncLocalStorage` implicit request tracing (not available in browsers; revisit if needed
  server-side).
