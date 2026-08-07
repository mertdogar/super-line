# pg_durable integration — implementation

## Destination

The durable-workflows kit exists in-repo per the planning map's
[spec.md](../pg-durable-integration/spec.md): two layers (workflow kit + thin
queue) with hardened lifecycle projection, retry-parity decided and implemented,
LogTape-bridged tracing, heavy-lane tests green — **ready to publish but not
published** (the graduation gate holds) — plus the "pg_durable beside
super-line" how-to page live on the docs site.

## Notes

- **Execution override:** this is an implementation map — tickets produce
  working code and published docs, not just decisions.
- Read first: [spec.md](../pg-durable-integration/spec.md) (§5 frictions, §6
  steps) and the planning map's assets, especially
  `workflow-kit-prototype-findings.md`. The prototype at
  `.scratch/workflow-kit-prototype/` is the starting point — absorb it, then
  wipe it (its NOTES.md says so).
- Standing facts:
  - npm `duroxide` pinned exactly 0.1.28 (still latest at scaffold time,
    2026-08-07). Known: `RetryPolicy.backoff` typed `number` but requires
    `'exponential'`; `timeoutMs` required. The linux-arm64 gap CLOSED —
    `duroxide-linux-arm64-gnu@0.1.28` ships on npm; only musl remains out.
  - duroxide is an **external** dependency — the internal peer-dep rule doesn't
    apply, but it's native: the package needs a supported-platforms statement.
  - The kit is a paired plugin like queue()/auth()/chat(): contract fragment
    contributes the `workflowRuns` collection; server plugin owns projection.
  - Tests need real Postgres → **heavy lane** (`heavy` list in
    vitest.config.ts), testcontainers like collections-pglite.
  - Published docs cite no ADRs or plans — state behavior.
  - The kit stays `private: true` / unpublished until the gate (real consumer +
    upstream locking/replay/shutdown bugs closed) — so **no** skills/super-line
    update, no release dance, no CHANGELOG stamping in this map.

## Decisions so far

- [Write and publish the "pg_durable beside super-line" how-to](tickets/01-docs-page.md) —
  live at `docs/how-to/pg-durable-beside-super-line.md`, registered in sidebar
  (Collections group) + how-to index; `pnpm docs:build` green. Boundary table,
  shared-Postgres requirements, and the Electric shape recipe with its four
  caveats.
- [Package identity: name, subpaths, platform statement](tickets/02-package-identity.md) —
  `@super-line/plugin-workflows`, one entry with a `workflows()` factory
  (queue-style, no client subpaths yet), platform gap documented + load error
  wrapped, `private: true` until the graduation gate.
- [Scaffold the kit and absorb the prototype](tickets/03-scaffold-kit.md) —
  `packages/plugin-workflows/` built per the identity decision (lazy native
  load, deny-all `workflowRuns`, setup-owned runtime with boot recovery);
  typecheck/lint green, both demo scenarios re-ran on SQLite against a real
  server, prototype wiped. linux-arm64 shipped upstream in 0.1.28.
- [Harden the lifecycle projection](tickets/04-harden-projection.md) — all
  four frictions in: bounded notfound tolerance, durable-row recovery
  (leaderless multi-node story documented), normalization (lowercase/parsed
  output/terminal clears customStatus), cancellation → `cancelled` + reason
  in the new `error` column. 4 focused tests on a real provider, ~4.3s.
- [Retry-parity: reimplement plugin-queue semantics or document divergence?](tickets/05-retry-parity.md) —
  permanent errors only, via a marker-envelope return (no hand retry loop;
  duck-typed `PermanentJobError`); jitter/timeout-retry adopt engine
  semantics, divergence documented; config stays the engine's shape, flat
  (`maxAttempts`/`timeoutMs` + `totalTimeoutMs` pass-through).

## Not yet specified

- Client-side surface beyond the `workflowRuns` collection (a `useWorkflow`
  hook? typed client for host-owned requests?) — wait for a real consumer to
  shape it.
- An `examples/workflows` app — probably graduation-time, not before.
- Any dedicated Control Center presentation beyond what the Collections view
  already gives `workflowRuns` rows for free.

## Out of scope

- **npm publication and everything it triggers** (skills/super-line update,
  release/CHANGELOG dance, version bumps) — gated on a real consumer plus
  upstream fixes; a fresh effort when the gate opens.
- The pg_durable-extension interop kit and any `df.instances` Control Center
  view — ruled out by the planning map's posture.
- Changes to plugin-queue or core — the posture explicitly leaves both alone.
