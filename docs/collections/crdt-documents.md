# CRDT document collections

Some state doesn't want to be a row table — a collaborative canvas, a rich-text doc, a scene graph. Those want **merge** (two people editing different fields converge) rather than last-writer-wins. A **CRDT document collection** covers this: one `collection(n)` concept away from a [row collection](/collections/row-collections), declared with a `crdt` option instead of a `key`.

## Declare a document collection

```ts
const contract = defineContract({
  collections: {
    messages: { schema: messageSchema, key: 'id' },                // LWW rows (queryable)
    scenes:   { schema: sceneSchema, crdt: { mode: 'document' } },   // CRDT docs (opened by id)
  },
})
```

A CRDT collection is **opened by id, not queried** — `collection(n).open(id)` returns a reactive document handle (`getSnapshot`/`subscribe`/`set`/`update`/`delete`), and concurrent edits merge instead of clobbering.

## Validate-before-commit

Unlike the old off-contract document stores, **the schema is enforced**. Every write is validated *before it commits*: the ingress node merges the incoming delta onto a scratch copy, snapshots it to plaintext, validates against the contract schema, and only then commits and fans it out. An invalid write is rejected server-side and never reaches other clients; the writer resyncs. (Relay nodes trust deltas already validated at the ingress node.)

This overturned ADR-0003's old premise that "merge deltas are unvalidatable" — see [ADR-0007](https://github.com/mertdogar/super-line/blob/main/docs/adr/0007-crdt-docs-are-typed-collections.md).

::: warning Keep CRDT schemas tolerant
Validation runs against the *post-merge* state, which a concurrent merge can leave **momentarily incomplete** — an overwrite of a field is internally a delete-then-insert, and under interleaved cross-node folds the delete can land a beat before the insert. Two consequences:

- **Aggregate constraints** (`maxItems`, cross-field invariants) can reject an honest writer under concurrency — put those in a request handler, not the schema.
- **A required field that is concurrently overwritten can transiently be absent.** If the schema hard-requires it, that transient state is rejected, the writer resyncs, and the resync churn can diverge the document's Yjs lineage until the field is dropped for good — permanently wedging the collection (every later write then fails the same check).

So for any field that is concurrently mutated, prefer `z.number().catch(0)` / `.optional()` over a bare `z.number()`: validation coerces a transient gap to a default instead of rejecting, and the next write restores the real value. Reserve strict/required only for fields written once and never concurrently overwritten.

This is also **what makes op-log compaction safe.** A durable/`self` backend periodically folds a doc's op-log into a baseline and trims the folded rows. The reject churn above leaves a permanent gap in the log, and compaction **bakes that gap-corrupted fold into the baseline** — turning a transient loss into permanent, cluster-wide corruption. A presence-tolerant schema means no rejects → no gaps → every baseline stays complete. Strict-required fields + compaction is the combination that wedges for good.
:::

See [ADR-0008](https://github.com/mertdogar/super-line/blob/main/docs/adr/0008-crdt-validation-is-scoped-to-present-values.md) for the full reasoning.

## Server: a backend + a guard, and create the doc

Give the server a CRDT backend (a separate backend from the [row backend](/collections/backends) — CRDT never joins a cross-collection atomic batch) and a [guard-shaped policy](/collections/policies#crdt-document-guards). **Creation is server-authoritative** — clients open existing documents:

```ts
import { crdtMemoryCollections } from '@super-line/collections-crdt-memory'

const srv = createSuperLineServer(contract, {
  crdtCollections: crdtMemoryCollections(),        // the CRDT backend
  policies: {
    scenes: {                                       // guard-shaped, deny-by-default
      read:  (principal, id, snapshot, ctx) => snapshot?.ownerId === principal,
      write: (principal, id, ctx) => true,
    },
  },
})
await srv.collection('scenes').create('board', { shapes: {} })  // creation is server-authoritative
```

Opening a nonexistent document returns `NOT_FOUND`; a client-initiated create routes through a request handler that calls `create`.

## Client: open a document

The client needs the universal `crdtCollectionsClient()` engine (one client engine pairs with every backend tier — the client only merges opaque deltas):

```ts
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'

const client = createSuperLineClient(contract, {
  transport, role: 'user',
  crdtCollections: crdtCollectionsClient(),
})

const doc = client.collection('scenes').open('board')
await doc.ready
doc.getSnapshot()                                   // current plaintext state
doc.subscribe((snapshot) => { /* re-render */ })
doc.update({ title: 'hello' })                      // merges + syncs to every open handle
```

### Attributing writes with `origin`

Every write is tagged with an `origin` — it's how the client echo-breaks its own writes on the merge feed, and how the Control Center's live feed attributes a change to whoever made it. `crdtCollectionsClient({ origin })` sets the engine-wide default (falling back to a random id); pass `{ origin }` to a single `open()` call to tag just that handle — handy when one client hosts more than one named writer, like a human tab alongside a co-located agent:

```ts
const client = createSuperLineClient(contract, {
  transport, role: 'user',
  crdtCollections: crdtCollectionsClient({ origin: 'agent:planner' }), // engine-wide default
})

const doc = client.collection('scenes').open('board', { origin: 'agent:planner:sub-task' }) // per-open override
```

`origin` is client-claimed and untrusted — policies never see it. It's for echo-break and attribution only.

### React

```tsx
const { data, update } = useDoc('scenes', 'board')
```

::: tip Watch it in the Control Center
Mount [`inspector()`](/how-to/control-center) and every document open/write/change streams to the live feed's **Collections** filter. Because deltas are opaque on the wire, a `crdt.write` row expands to the **decoded post-merge snapshot** the server validated — so you can watch edits (including a server-side agent's co-writes, stamped with their `origin`) land in real time.
:::

## Run it

- [`examples/ai-canvas`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas) — a collaborative canvas over `@super-line/collections-crdt-memory` with a **server-side AI agent** as a co-writer: `srv.collection('scene').open(id)` reads the live board and drives it while you keep editing in two tabs; the edits **merge** (concurrent edits to different fields both survive).
- [`examples/ai-canvas-pglite`](https://github.com/mertdogar/super-line/tree/main/examples/ai-canvas-pglite) — the same board re-clustered across two nodes on `@super-line/collections-crdt-pglite` (central Postgres + Electric), validate-before-commit at the ingress node.
- [`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor) — a CRDT document attached to a **chat channel** as a [channel resource](/how-to/chat-resources): a human and a Mastra agent co-edit one canvas, the agent writing through the chat plugin's acked `write_resource` path instead of a raw co-writer.

## Next

- [Attach collaborative resources to channels](/how-to/chat-resources) — make a CRDT document channel-native: membership-gated, with an agent-friendly acked write path and who's-open presence.
- [Row-level security & policies](/collections/policies#crdt-document-guards) — the guard-shaped CRDT policy in depth.
- [Backends & clustering](/collections/backends#crdt-backends) — the durable and self-clustering CRDT tiers.
- [Tutorial 3 · Go collaborative](/tutorials/go-collaborative) — build one hands-on, two tabs merging live.
