# ADR-0025: Collaborative text lives in a native root beside the described one, and ingress validation is per-collection

- Status: Accepted
- Date: 2026-07-29

## Context

ADR-0007 folded CRDT documents into collections, and the guide has advertised "a collaborative
canvas, **a rich-text doc**, a scene graph" ever since. The canvas and the scene graph work. The
rich-text doc never did, and could not, for two independent reasons.

**The engine has no text type.** super-store maps a `StoreValue` onto Yjs by kind: scalars become
a `Y.Map` value-cell, objects a `Y.Map`, arrays a `Y.Array`, `Set`/`Map` their hashed forms.
There is no `Y.Text` and no `Y.XmlFragment`. A string is a *cell*, so a write **replaces** it —
diff-and-patch descends to the field and no further. Two people typing in one paragraph is
therefore last-writer-wins, which is the one thing collaborative text must not be. Nor can the
text be nested inside the described root and left alone: that root is owned end to end by
`patchDeep`, which would fight any foreign type living in it, and by `getSnapshot`, which would
try to materialise it.

**Validation cannot run at keystroke rate.** Validate-before-commit merges the incoming delta onto
a *scratch copy* of canonical state, materialises plaintext, and checks it against the contract.
A CRDT has no cheap clone, so that cost is proportional to document size and history depth: on the
`self` tier it is a full op-log `SELECT` plus a replay of every row, behind additional round-trips
— per delta. Affordable per shape or per scene field; ruinous per character.

Two facts made the shape of the answer clear. First, the wire is **already** a whole-document
relay: `encodeState()` is `Y.encodeStateAsUpdate(doc)` over every root, catch-up reads the same,
and a compaction baseline is that same whole-document encoding rather than a re-encoding of the
snapshot. Second, super-store binds only the root key `"root"`, and `getSnapshot()` materialises
only that one. So a second root would already replicate, already survive compaction — and be
invisible to everything downstream of the snapshot.

Skipping validation was not novel either. A delta relayed from another node has already passed the
gate at *its* ingress node, and the relay path said so — by passing `() => {}`. The backend could
not distinguish that from a real check, so every node in a cluster rebuilt the whole document and
materialised its plaintext in order to call an empty function.

## Decision

**Collaborative text lives in a native root — a CRDT type bound beside the described root in the
same document — and ingress validation is a per-collection property declared on the contract.**

Three changes, each subtractive or additive rather than structural:

1. `DocOptions.validate?: boolean` (default `true`). `false` makes the server pass **no** validator.
2. `CrdtCollectionStore.apply(change, opts, validate?)` — the validator becomes optional, and an
   implementation **must branch on its absence and skip the fold**, not run it and discard the
   result. The fold is the entire cost; ignoring the outcome is not the same optimisation. The
   relay path now passes nothing, so the existing waste disappears with no configuration at all.
3. `ResourceReplica.native?()`, surfaced as `DocHandle.native()` and `useDoc().native`, typed
   `unknown` and narrowed by `yDocOf()` from the engine package.

The asymmetry is the whole concept: **replication is free, legibility is forfeit.** A native root
is outside the contract's described shape — not part of the document's inferred type, never in the
snapshot, invisible to validation, to the queryable projection and to the inspector.

### Why `unknown`, narrowed elsewhere

`@super-line/client` has one runtime dependency and no CRDT vocabulary; ADR-0007 made the client
engine an interface precisely so the client would stay free of super-store. Typing `native()` as a
`Y.Doc` would end that. So the accessor lives in `@super-line/collections-crdt-memory`, which
already owns the dependency, and derives the type from super-store's own accessor rather than
importing `yjs` — naming the package would risk a second physical copy resolving there, and
documents from two copies of Yjs do not interoperate. It is the duplicate-core `instanceof` trap
with a worse failure mode.

### Why the toggle is on the contract, beside the schema

Enforcement is elsewhere server-side — `policies` is a server option, not contract surface — so
this could have been either. It sits on the contract because it is *about* the schema next to it:
it says "this shape is not enforced here", which is unreadable on its own but obvious in place. It
also makes an unvalidated collection visible to every reader of the contract, the inspector
included. The cost is that `DocOptions` is no longer purely super-store's; backends forward the bag
to `StoreValue`, which ignores keys it does not know.

### Why mutations became void

`set`/`update`/`delete` used to return a `StoreChange` the client wrote through, pulled from a
one-slot field the replica filled on the next local update. That was sound only while they were the
only writers. A native root has no such call to return through, and two quick keystrokes would
overwrite each other in the slot. Local changes are now **pushed** through `onLocalChange`, which
also deletes the pull machinery — there is one path out, whoever wrote.

## Consequences

- **A native root is never validated.** The policy remains the only gate on such a collection: it
  still decides *who* may write, and nothing then decides *what*. This is not a weakening of
  validate-before-commit so much as an admission of its domain — there was never a schema that
  could describe a ProseMirror fragment mid-merge.
- **A native handle does not survive `reset`.** Reject→resync rebuilds the replica on a fresh
  document (a value-patch leaves compensating ops and diverges permanently), orphaning anything
  bound to the old one. A native root cannot *cause* a rejection, being invisible to validation —
  but a described field in the same document can. So keep validatable state out of a document
  carrying a native root: declare `validate: false` and model its metadata as a row collection
  beside it. `examples/react-chat-transports` does exactly this, using plugin-chat's `resources`
  row for the title and a CRDT collection for the prose.
- **A root's kind is fixed on first use.** Opening `body` as a `Y.Text` permanently stops anything
  else opening it as the `Y.XmlFragment` an editor expects. Every writer must agree on the kind,
  which is one more reason the root name belongs in a shared constant rather than inlined twice.
- **Awareness is not covered by any of this.** Cursors and selections are a separate Yjs protocol
  that never travels on a document update, and are meant to evaporate. They need an ephemeral
  broadcast — a request and an event over a room — which stays app-level for now rather than
  becoming a package on the evidence of one use case.
- **Relay clusters get faster for free.** Every non-ingress node stops folding a whole document per
  relayed delta.
- `ResourceReplica` changed shape (mutations return `void`, plus `onLocalChange`). One
  implementation and one consumer existed, both in-tree.
