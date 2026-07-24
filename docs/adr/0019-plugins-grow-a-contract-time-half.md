# ADR-0019: Plugins grow a contract-time half — typed fragments merged at `defineContract`

- Status: Accepted
- Date: 2026-07-24 — records a decision settled 2026-07-06 (`PLAN-plugin-auth.md` grilling) and shipped the same day (commit `df7e72d`, core 0.10.1 / server 0.10.2); written retroactively because ADR-0016 and both first-party plugins already lean on it
- Amends: [ADR-0005](0005-plugins-as-paired-runtime-bundles.md) (which scoped plugins "Runtime-only by constraint")
- Amended by: [ADR-0016](0016-merged-contracts-retain-their-plugin-fragments.md) (the merge as shipped here discarded the plugin list; 0016 retains it)
- Plan: `PLAN-plugin-auth.md` (settled decision 6; Phase 0 type spike; Phase 1)

## Context

ADR-0005 built plugins as **paired runtime bundles** and deliberately kept them out of the
contract: "end-to-end types hang off the contract object known at `defineContract` time, so a
plugin passed to the server factory can never retroactively add typed surface — contract
contribution must stay at the `mergeSurfaces` site." That constraint is real and this ADR does
not touch it. What it revisits is the conclusion drawn from it — that a plugin's typed surface
must therefore be woven in **by hand**.

Designing `@super-line/plugin-auth` broke the manual weave. The day-one plugin already owned
three secret-bearing collections (`users`/`credentials`/`sessions`), a brand-new `guest` role,
and four requests across `guest` + `shared` — five collections and nine requests by the end of
that same day (API keys, password reset), seven collections since (connection sessions +
presence, 2026-07-22). A host mounting that via ADR-0004/0005 machinery would hand-merge
surfaces, hand-declare secret collections in its own contract file, and hand-wire policies —
reproducing, at growing scale, the exact 4–5-config-site weaving ADR-0005 was written to
dissolve. And because types hang off
the contract object, no server-factory mechanism could fix it; the fix had to live at
**contract-definition time**.

## Decision

A paired plugin gains a **contract-time half**: a named, typed contract fragment merged by
`defineContract` itself.

- **`ContractPlugin` = `{ name, fragment }`**, where a `ContractFragment` is any subset of a
  contract's typed surface: `{ shared?, roles?, collections? }` (`packages/core/src/contract.ts`).
  `defineContractPlugin(name, fragment)` authors one; its `const` type parameter preserves
  literal keys and `subscribe: true`, exactly like `defineSurface`. Fragments carry LWW and
  CRDT collection defs alike, may add brand-new roles or merge into existing ones, and a role
  block's `data`/`env` schemas ride along.
- **`defineContract({ plugins: [...] })` merges fragments into the contract.** At the type
  level the merge is a plain **intersection** — `ResolveContract<C> = Flat<C &
  UnionToIntersection<fragments>>` — so `RowOf`, `CollectionName`, per-role `Requests`, and
  `client.collection(n)` all infer from the single materialized contract with **zero
  generic-threading**: every existing extractor works unchanged because intersection
  distributes per key. The no-plugins overload is the **identity** (same object reference
  back), so existing callers are untouched.
- **The runtime merge lives in `defineContract`, in plugin array order**, with its own
  `mergeDirectional`/`mergeRoleBlock` (not `mergeSurfaces`). A duplicate collection name or
  surface key **throws naming the plugin and the key**. This lands on the "startup throws
  naming the key" side of ADR-0005's collision ladder: `mergeSurfaces`' compile-time
  `NoOverlap` check does not extend to a variadic fragment list, so plugin collisions are
  enforced at `defineContract` execution instead — loudly, never silently.
- **Policies stay on the runtime half.** A fragment is pure typed surface; access is server
  behavior, so the server-side `SuperLinePlugin` (same commit) contributes `policies`, merged
  into the host's at construction — a policy for an undeclared collection throws ("register
  its contract fragment on `defineContract({ plugins })`"), and a collision with the host or
  another plugin throws too. Nothing ever wins a policy overlap: whoever policies a collection
  owns its access story, and a plugin may legally policy a collection it did **not** declare
  (chat's kind registry gating host-declared CRDT collections) — the collision throw is what
  keeps that unambiguous.
- **`SubtractHandlers` drops fully-plugin-owned blocks to optional** (`packages/server/src/index.ts`):
  a block whose every key a plugin handles collapses to `{}` and becomes optional, so a host
  writes `implement({ user, admin })` with no empty `shared: {}` / `guest: {}` stubs.

Recorded alternatives (from the plan, verbatim rationale): **server/client generic-threading**
of the fragment through the factories — rejected as "fragile" (a Phase 0 type spike proved the
intersection instead, promoted into core as `packages/core/test/plugin-contract.test.ts`); and
**everything-in-contract** — the host hand-declaring the plugin's collections and requests in
its own contract — rejected because it "leaks secrets" (a plugin's deny-all internals become
host-authored surface) and re-imposes the manual weave.

## Consequences

- **ADR-0005's "runtime-only" heading is now false of the plugin *system* and still true of the
  server factory.** Contribution moved to a second contract-definition-time site, not to the
  factory: `createSuperLineServer` merges zero surface (a `SuperLinePlugin` still cannot add
  typed surface; a reserved connection's contract stays parallel, never merged). The invariant
  0005 derived — typed surface is fixed when the contract object is created — is preserved;
  only the mechanical site it named (`mergeSurfaces`) generalized.
- **Both first-party plugins are built on it** — `plugins: [authContract(), chatContract()]` —
  and compose through it: `chat()` fails fast at kit construction unless the contract declares
  all eight chat-domain collections, two of which come from **auth's** fragment.
- **Collisions are runtime-only.** A colliding fragment key typechecks (the defs just
  intersect) and throws only when `defineContract` executes. Weaker than `mergeSurfaces`'
  compile error, accepted per 0005's ladder; the throw fires at module load, so it cannot
  reach production silently.
- **One dimension is silent**: role `data`/`env` schemas merge first-declared-wins
  (`a.data ?? b.data`) — no compile error, no throw. Host-over-plugin is usually what's wanted,
  but two plugins declaring `env` on the same role will not be told.
- **Provenance was discarded as shipped** — the original merge dropped the `plugins` list and
  `ResolveContract` omitted it from the type, so nothing downstream could attribute a merged
  key to its fragment. ADR-0016 reversed that seventeen days later (core 0.14.1).
- **Each paired plugin now carries two fragment-shaped objects that can drift**: the contract
  fragment (real schemas, feeds the contract) and the paired subtraction surface (feeds
  `SubtractHandlers`) — auth's `authSurface` reuses the fragment's own request defs verbatim,
  while chat's `chatSurface` types bodies as `z.unknown()` (its server never inspects message
  content). Handler subtraction keys off the surface; contract types come from the fragment.
  Keeping them in step is the plugin author's job.
