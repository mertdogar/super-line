# PLAN — super-line collections (typed rows, subset sync, TanStack DB adapter)

The relational successor to the LWW store family: **contract-declared, schema-typed row
collections** with predicate-subset subscriptions, RLS-style row security, and atomic batch
writes — designed so that **TanStack DB is the client query engine** (joins, live queries,
optimistic transactions) and super-line is the **server-authoritative sync source** beneath it.

Decided in a grilling session (`/grill-me`) on 2026-07-05. Backward compatibility was explicitly
out of scope. Companion ADR: `docs/adr/0006-collections-are-on-contract-typed-rows.md` (narrows
ADR-0003 to the CRDT doc-store family).

Two findings shaped the whole design:

1. **The current store model is already "a collection of keyed documents"** — a namespace holds
   many `Resource{id, accessRules, data}`, each with its own change feed (`sch`/`sdel`) and a
   server-side `list()`. What's missing for tables is: typed `data`, client-visible querying,
   subset subscriptions (not open-by-id), and predicates over row contents. So a collection is a
   namespace, and a row is a resource — evolution, not a parallel system.
2. **TanStack DB deliberately does not prescribe a sync engine.** Collections are populated by
   pluggable sync sources (Electric, PowerSync, TanStack Query, custom); since 0.5,
   *query-driven sync* pushes each live query's `where/orderBy/limit` down to the source, and a
   source may legally return a **superset** (the client re-filters locally). That seam is exactly
   where super-line plugs in — and the superset rule gives us a graceful fallback for any
   predicate we can't push down.

---

## The decision tree (dependency order)

| # | Fork | Decision |
|---|------|----------|
| 1 | Where do live queries run? | **Client-side in TanStack DB** via a first-party adapter. No native query engine, no Zero-style server-evaluated queries. |
| 2 | What is a collection structurally? | **Collection = namespace, row = resource** (resource id = primary key). |
| 3 | Where do schemas live? | **On the contract** (`collections:` block, Standard Schema). Server validates every row write. |
| 4 | Subscription granularity | **Full expression pushdown**: subscribe with `filter + orderBy + limit`. |
| 5 | Expression format on the wire | **Own small versioned IR in core**; adapter translates TanStack trees → IR, over-fetches on untranslatable nodes. |
| 6 | Write path | **Atomic batch frame** of insert/update/delete ops (maps 1:1 to a TanStack transaction). Contract requests remain the business-logic escape hatch. |
| 7 | Row authorization | **RLS-style predicate policies** per collection (server-side): `read → IR filter`, `write → boolean guard`. No per-row ACL storage. |
| 8 | Relations / FKs | **Metadata + opt-in advisory existence checks.** No core cascades (unsound under masterless relay anyway). |
| 9 | Family fate | **Collections subsume the LWW store family**; CRDT doc stores (`store-sync*`) continue unchanged. |
| 10 | Native client surface | **Live row-set primitive** + thin `useCollection` in react; anything relational → TanStack. |
| 11 | orderBy/limit semantics | **Snapshot-only; client owns the window**; adapter backfills on underfill. Server holds no per-subscription state beyond the predicate. |
| 12 | Reconnect | **Re-snapshot + client-side diff** → minimal delta events. Resume tokens deferred to `self` stores (only place a global LSN exists). |
| 13 | Registration & packaging | **One backend serving all contract collections** (single transaction domain); new `@super-line/collections-*` packages. |
| 14 | Phasing | **Tracer bullet through a TanStack chat demo** on the memory backend first. |

---

## Topology

```
  contract (single source of truth)
    collections: { users: {schema, key}, messages: {schema, key, references} }
         │                                        │
         ▼  server                                ▼  client
  ┌─────────────────────────────┐        ┌──────────────────────────────┐
  │ createSuperLineServer        │  wire  │ client.collection(ns)         │
  │  collections: backend (ONE)  │◀──────▶│  .subscribe(query: IR)        │──▶ live row-set
  │  policies: RLS per collection│  csub/ │  .insert/.update/.delete      │     │
  │                              │  cchg/ │  .batch(ops)                  │     ▼
  │ core owns:                   │  cbat  └──────────────────────────────┘  @super-line/tanstack-db
  │  schema validation           │                                          superLineCollectionOptions()
  │  policy enforcement          │                                             │
  │  IR evaluator (routing)      │                                             ▼
  │  relay fan-out over Adapter  │                                    TanStack DB collections
  └─────────────────────────────┘                                    useLiveQuery (joins, windows,
        │ relay: batch fans as ONE adapter                            optimistic transactions)
        │ message, applied atomically per node
        ▼
   other nodes (full replica each)        self (pglite): central Postgres+Electric is the bus,
                                          no adapter — same as store-pglite today
```

## Contract surface

```ts
const contract = defineContract({
  collections: {
    users: { schema: userSchema, key: 'id' },
    messages: {
      schema: messageSchema,          // any Standard Schema (zod/valibot/arktype)
      key: 'id',                      // row[key] → resource id (primary key)
      references: { authorId: 'users', channelId: 'channels' },  // metadata (see FKs)
    },
  },
  clientToServer: { /* unchanged */ },
  serverToClient: { /* unchanged */ },
})
```

- Types flow as everywhere else: `InferOut<schema>` is the row type on server handle, client
  handle, react hook, and the TanStack collection. No codegen.
- This **narrows ADR-0003**: LWW `update` payloads *are* the value, so they are validatable —
  the exact carve-out ADR-0003 anticipated. CRDT stores stay off-contract (opaque deltas).

## Expression IR (core)

```ts
type Expr =
  | { op: 'and' | 'or'; args: Expr[] }
  | { op: 'not'; arg: Expr }
  | { op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'; field: string; value: Json }  // field = dot path
  | { op: 'in'; field: string; values: Json[] }
  | { op: 'like' | 'ilike'; field: string; pattern: string }

type CollectionQuery = {
  filter?: Expr
  orderBy?: { field: string; dir: 'asc' | 'desc' }[]
  limit?: number
  offset?: number
}
```

- **One shared evaluator in core** (`evalExpr(expr, row)`) is what makes full pushdown tractable:
  change-feed routing always has the row in hand, so routing uses the evaluator everywhere; any
  backend may serve snapshots by scan+filter. SQL backends compile IR → SQL purely as a snapshot
  optimization, never for correctness.
- The IR is versioned wire vocabulary owned by super-line — stable across TanStack releases and
  usable by non-TanStack clients.

## Wire frames (names indicative, final naming open)

| frame | dir | shape (sketch) | notes |
|-------|-----|----------------|-------|
| `csub` | c→s | `{i, n, q: CollectionQuery, subId}` | subscribe; snapshot rides the `res` ack (like `sopen`) |
| `cuns` | c→s | `{n, subId}` | unsubscribe |
| `cbat` | c→s | `{i, ops: RowOp[]}` | atomic batch; `RowOp = {n, op: 'insert'|'update'|'delete', id, data?}`; ack = commit, err = rollback |
| `cchg` | s→c | `{n, subId[], rows: AppliedOp[], nd?}` | routed row changes (insert/update/delete) per matching subscription |

- Per-op server pipeline: schema-validate → `write` policy guard → (optional advisory ref check)
  → apply batch atomically at the backend → route via evaluator to local subs → relay fan-out.
- Relay fan-out ships the **whole batch as one adapter message**; remote nodes apply it
  atomically too, so intermediate states never leak to their local subscribers.

## Row security (RLS-style policies, server-side only)

```ts
createSuperLineServer(contract, {
  transports: [...],
  collections: sqliteCollections({ file: 'app.db' }),   // ONE backend, all collections
  policies: {
    messages: {
      read: (principal, ctx) =>
        ({ op: 'in', field: 'channelId', values: ctx.channelsOf(principal) }),
      write: (principal, op, next, prev) =>
        op === 'insert' ? next.authorId === principal : prev?.authorId === principal,
    },
  },
})
```

- `read` returns an IR filter **ANDed into every snapshot, subscription, and change-route** for
  that caller — one evaluator does visibility and routing. Deny-by-default: no policy → server-only.
- Known caveat (accepted): row-side predicates (`row.members` contains principal) re-evaluate
  naturally on row change; **principal-side state captured at subscribe time goes stale** until
  resubscribe. Document it; expose a server-triggered resubscribe hook.
- Policies are callbacks → they live in server options, never in the contract, never on the wire.

## Relations / FKs

- `references: { authorId: 'users' }` is **metadata**: Control Center draws the schema graph;
  the TanStack adapter uses it as join-batching hints.
- **Opt-in advisory existence check** at the accepting node on write — catches honest bugs.
  Documented as best-effort under relay (no global serialization point → two nodes can
  concurrently insert-child / delete-parent), real under `self`.
- **No cascades in core.** Deletion side-effects are userland: a contract request handler or a
  server `onDelete` hook deletes children explicitly. `self` backends may layer real DB FKs later.

## Client primitive + react sugar

```ts
const msgs = client.collection('messages')          // typed from contract
const sub = msgs.subscribe({ filter: eq('channelId', 'general') })
sub.rows          // current row map
sub.on(evt)       // insert / update / delete row events (post-diff, minimal)
sub.ready         // initial snapshot applied
await msgs.insert({...}); await msgs.batch([...])   // → cbat

// react: thin filtered live array, no joins, no query engine
const rows = useCollection('messages', { filter: eq('channelId', id) })
```

- **Reconnect:** re-subscribe → fresh snapshot → diff against cached rows → emit only the delta.
  Correct on any node, zero server state, no UI flicker.
- **Windows:** `orderBy/limit` shape the initial snapshot only; live phase streams every
  filter-matching change; the consumer re-applies the window locally and requests a backfill
  snapshot on underfill (the adapter does this automatically).

## TanStack DB adapter (`@super-line/tanstack-db`)

```ts
const messages = createCollection(
  superLineCollectionOptions(client, 'messages', { syncMode: 'on-demand' }),
)
```

- Derives `schema` + `getKey` from the contract — end-to-end types with zero config.
- Translates `loadSubsetOptions` expression trees → IR; untranslatable nodes are dropped toward a
  **broader** subscription (superset is always safe — TanStack re-filters locally).
- Maps a TanStack transaction's mutations → **one `cbat` frame**; ack resolves the optimistic
  commit, error rolls it back.
- Handles window backfill + reconnect resubscription on top of the client primitive.
- Joins, aggregates, live queries: TanStack's differential-dataflow engine (d2ts), not us.

## Packaging & family fate

- **New packages:** `@super-line/collections-memory` (relay, default/tests),
  `collections-sqlite` (relay, durable), `collections-pglite` (**self**: central Postgres +
  Electric, same topology as store-pglite), `@super-line/tanstack-db`.
- Core gains: contract `collections` block, IR + evaluator, wire frames, backend interface,
  policy enforcement. React gains `useCollection`.
- **LWW store packages (`store-memory`, `store-sqlite`, `store-pglite`) are deprecated in
  place** — a doc is a one-row collection; open-by-id `ResourceHandle` DX survives as sugar over
  `subscribe(pk == id)`.
- **CRDT doc stores unchanged** (`store-sync`, `store-sync-libsql`, `store-sync-pglite`):
  collaborative documents are a different animal (opaque deltas — unvalidatable, unfilterable).
  Terminology splits cleanly: **rows = collections, docs = stores**.
- Clustering is inherited, not redesigned: memory/sqlite = relay (full replica per node, batches
  over the adapter), pglite = self (Electric is the bus, no adapter).

## Phases

1. **Tracer bullet (proves the headline end-to-end):** contract `collections` block · IR +
   evaluator · wire frames · policy enforcement · `collections-memory` · client primitive +
   `useCollection` · `@super-line/tanstack-db` · chat example with `useLiveQuery` joining
   `messages ⊕ users`.
2. **Durability + operator view:** `collections-sqlite` (IR→SQL compilation) · advisory FK
   checks · Control Center schema graph + collection browsing.
3. **Self clustering + sunset:** `collections-pglite` · deprecate LWW `store-*` packages ·
   docs overhaul (guide + skill + positioning).

## Deliberately open (implementation-time, not design forks)

- Final wire frame names; IR version negotiation mechanics.
- How the policy `ctx` is populated (likely from `authenticate`/`identify`, same as `principal`).
- Adapter-side dedup of overlapping subscriptions (TanStack collapses duplicate subset requests
  already; whether we also dedup at the wire).
- Whether `useCollection` ships in phase 1 or waits for demand.

## Research trail

- TanStack DB: [overview](https://tanstack.com/db/latest/docs/overview) ·
  [0.1 announcement](https://tanstack.com/blog/tanstack-db-0.1-the-embedded-client-database-for-tanstack-query) ·
  [0.5 query-driven sync](https://tanstack.com/blog/tanstack-db-0.5-query-driven-sync)
- Ecosystem: [Electric + TanStack DB](https://electric-sql.com/blog/2025/07/29/local-first-sync-with-tanstack-db) ·
  [TanStack DB vs Zero vs LiveStore (2026)](https://www.pkgpulse.com/guides/tanstack-db-vs-zero-vs-livestore-sync-engines-2026) ·
  [Choosing a sync engine in 2026](https://johnny.sh/blog/choosing-a-sync-engine-in-2026/)
- Poles considered and rejected: **Zero** (server-evaluated queries — the invalidation machinery
  we opted out of), **LiveStore** (event-sourced log — different paradigm), building our own
  differential-dataflow engine (months replicating d2ts).
