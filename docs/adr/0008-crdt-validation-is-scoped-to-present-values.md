# ADR-0008: validate-before-commit is scoped to present-value validation; CRDT schemas must be presence-tolerant

- Status: Accepted
- Date: 2026-07-09
- Amends: [ADR-0007](0007-crdt-docs-are-typed-collections.md) (narrows its validate-before-commit guarantee)
- Investigation: real-browser `/diagnose` of the `ai-canvas-pglite` two-tab sync-wedge

## Context

ADR-0007 gave CRDT documents a **validate-before-commit** gate: the ingress node merges an inbound
delta onto a scratch copy, snapshots to plaintext, validates the **whole post-merge document** against
the contract schema, and commits only if it passes. Its stated promise: *"a buggy or malicious client
can no longer merge a schema-invalid document."*

That promise is unachievable, and enforcing it is actively harmful. A CRDT overwrite of a field is
internally *delete-then-insert*; under interleaved cross-node folds the delete can land a beat before
the insert, so a **required field is transiently absent** in the post-merge snapshot. Validating the
whole document then rejects a legitimate mid-merge state. The rejection triggers a full-state resync,
and the resync churn leaves a **permanent causal gap** in the op-log (the rejected write's Yjs struct
never lands, yet its optimistic successors do). A later committed delta whose insert references that
gap folds with its delete applied but its insert orphaned → the field is dropped for good; compaction
then bakes the loss into a durable baseline. One transient, hard-rejected, becomes a permanently
wedged collection (every subsequent write fails the same required-field check).

The root confusion: validate-before-commit validated the **convergent document** when all it can
soundly speak to is **the write's own contribution**. A CRDT guarantees eventual convergence of the
*set* of writes, not the validity of every intermediate snapshot.

## Decision

**Keep validate-before-commit, but scope its guarantee to present values, and make presence-tolerance
the schema author's responsibility.**

- The gate's real, honest guarantee is: **every value a write sets has the right type.** It cannot
  guarantee the document is *complete* at any instant — a concurrently-overwritten field may be
  momentarily (or, under an already-degraded op-log, lastingly) absent, and that is inherent to CRDT,
  not a validation failure.
- Therefore a CRDT-document schema **must be presence-tolerant** for any concurrently-mutated field:
  `z.number().catch(0)` / `.optional()` rather than a bare `z.number()`. `required` is reserved for
  fields written once and never concurrently overwritten. Structural/required guarantees are
  established at **server-authoritative `create`** (ADR-0007, Q10), where the doc starts valid.
- This is **load-bearing, not ergonomic**: presence-tolerant schemas are what make **op-log
  compaction** safe. No rejects → no permanent gaps → the seq-order fold and every baseline stay
  complete. Strict-required fields + compaction is the combination that wedges for good.

## Alternatives considered

- **Full-document strict validation (ADR-0007 as originally shipped).** Rejected: promises a guarantee
  a CRDT cannot keep and manufactures the corruption above. This is the status quo the decision amends.

- **A generic framework fix — "validate the write, not the document" via back-fill.** Implemented and
  **empirically rejected.** `validateCrdtSnapshot(schema, post, prev)` tried `schema(post)`, and on
  failure re-validated `fillMissing(post, prev)` (missing leaves back-filled from the pre-write state),
  tolerating a mere gap while still rejecting a bad value. Verified live in Docker with a strict schema:
  it **failed and made things worse** — 352/1115 rejects and partial shapes, vs. the original 293. It
  only tolerates a drop while `prev` still has the field; the first tolerated drop degrades the
  committed state, so `prev` itself goes partial, subsequent writes can't back-fill, and the cascade
  resumes with positive feedback. **A robust *generic* fix is impossible:** core validates through
  opaque **Standard Schema** (Zod/Valibot/ArkType) and cannot introspect a validator to derive a
  presence-tolerant variant (even Zod's own `deepPartial` does not recurse into `z.record()`). Only the
  schema *author* can express presence-tolerance, which is why the decision puts it there. (The code was
  reverted; not shipped.)

- **Ditch CRDT validation entirely (revert to ADR-0003 semantics).** Viable and robust — no gate → no
  rejects → no gaps → clean convergence — but it drops the "no garbage value" guarantee and makes every
  reader defensive. Deferred, not chosen: present-value validation is cheap and worth keeping. Left as
  the escape hatch if the tolerant-schema discipline proves too costly.

## Consequences

- **The typed-contract spine still covers CRDT writes, honestly.** "Every value is validated" holds; the
  overclaimed "the document is always fully valid" is dropped. A garbage-*value* write is still rejected;
  a mid-merge *gap* is tolerated and converges.
- **Presence-tolerance moves into the schema and the docs, not the framework.** The `ai-canvas-pglite`
  example uses `.catch()`; the ADR-0007 consequences and the collections guide document the rule and its
  compaction corollary. There is no silent core mechanism — by necessity (Standard Schema opacity), and
  by preference (an honest constraint beats server-side cleverness that papers over corruption).
- **Optional future ergonomics.** A Zod-specific, opt-in `crdtTolerant(schema)` helper applied at
  contract-definition time (author owns it, so it *can* introspect) could deep-optionalize a schema
  without hand-annotating every field. Not built; a convenience, not a correctness fix.
- **No code change ships from this ADR.** The fix that resolved the wedge was the tolerant example schema
  + the documented constraint (`f2d9fef`); this ADR records *why* that is the right layer and why the
  generic alternatives were rejected, so the dead-ends are not re-explored.
