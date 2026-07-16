# ADR-0010: A reusable plugin's mutations are requests-first, wrapped in domain-layer hooks

- Status: Accepted
- Date: 2026-07-16
- Builds on: [ADR-0005](0005-plugins-as-paired-runtime-bundles.md) (paired plugins), [ADR-0006](0006-collections-are-on-contract-typed-rows.md) (collections + RLS)
- Origin: a `/grilling` session designing `@super-line/plugin-chat` (see `PLAN-plugin-chat.md`)

## Context

Collections (ADR-0006) let a client mutate rows directly: `client.collection('messages').insert(row)`
travels to the server, which validates it against the contract schema and a per-row `write` policy, then
fans it out. The `examples/collections-chat` app leaned into that — its stated philosophy was **"no
`send`/`createChannel` requests — those are optimistic row writes now."** Row-writes buy client optimism
(TanStack DB shows the row instantly, rolls back on rejection) essentially for free.

When we set out to package that same chat model as a **reusable plugin**, the row-write approach stopped
paying. Three forces pushed the other way:

1. **Some operations can't be a single row write.** Creating a channel is two rows — the channel *and* the
   creator's owner-membership — and it is chicken-and-egg: you cannot satisfy an owner-membership write
   policy for a channel that does not exist yet. Deleting a channel is a cascade (its memberships and
   messages), and FKs are advisory with no cascades. These *must* be server-authoritative handlers.

2. **A write policy is a per-row boolean — it cannot host cross-cutting logic.** The whole point of a
   backbone plugin is that a *host* extends it: spam-filter a message, mirror it to an audit log, fan a
   notification, rewrite its body. There is nowhere in `write(principal, op, next, prev)` to hang that,
   and you cannot hook a raw row-write at all.

3. **Server-authored writes and client writes should behave identically.** An AI agent posting via the
   plugin's server API and a human posting from the browser should both trip the same spam filter and the
   same audit hook. A row-write path and a separate imperative path are two code paths that drift.

## Decision

For a reusable domain plugin, **every mutation is a contract request**, not a client row-write. The
plugin's collections are declared **client-read-only**: their `read` policies still scope visibility
(RLS), but `write` is omitted everywhere, so deny-by-default makes the collections a pure **sync surface**.
Each of the plugin's requests is handled by a server-authoritative handler that co-writes through
`srv.collection(n)` (policy-free, still schema-validated, still fans out).

Underneath the requests sits **one domain core per operation**. The request handler and the plugin's
**imperative server API** (`chatKit.messages.send(…)`, used by hosts and agents) both call the same core.
Hosts extend the core with **before/after hooks**:

- `before(input, initiator)` may **transform** (return a new input) or **veto** (throw → nothing is
  written).
- `after(result, initiator)` observes the committed write; if it throws, the error propagates but the
  write stays (it already committed).
- `initiator` is `{ kind: 'client', userId } | { kind: 'server' }`, so a host can exempt trusted
  server/agent writes from a check with one branch — but by default both run the identical core.

Because the hooks wrap the **domain layer**, not the wire layer, they fire for client requests and
server-initiated calls alike. There is one extension point and it is impossible to bypass.

## Consequences

**Gained.** Server-authoritative ids and timestamps (no trust in a client clock); one un-bypassable
extension seam that a host can't forget to call; multi-row and cascade operations expressed honestly; the
imperative kit and the wire handlers can never diverge because they are the same function.

**Given up.** Optimistic sends. A message appears when the server confirms it, not instantly — the plugin
is non-optimistic by construction. A host that wants optimism layers it above (e.g. a local echo keyed on
a client-side nonce). Live *reads* are unaffected; only the write round-trip is visible.

**Not a reversal of ADR-0006.** Direct row-writes remain the right tool for an *app's own* collections,
where the schema + a `write` policy fully capture the rule and optimism matters — that is exactly what the
`examples/collections` app still does. This ADR scopes the requests-first shape to **reusable plugins**,
where hookability and server-authority outweigh optimism. The two models coexist on one contract.

**Locks in a plugin idiom.** `@super-line/plugin-chat` is the first plugin built this way; future domain
plugins should follow it (read-only collections + request handlers + domain cores + before/after hooks +
an imperative kit) rather than exposing writable collections. `plugin-auth` already had the shape in spirit
(identity mutations are `signIn`/`signUp`/… requests over deny-all collections); this ADR names it.
