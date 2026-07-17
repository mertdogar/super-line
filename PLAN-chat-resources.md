# PLAN-chat-resources — channel-linked collaborative resources for plugin-chat

**Status: BUILT 2026-07-17 — all 3 phases on branch `chat-objects` in one pass (registry+access ·
writes+agents+cards · presence+origin+docs), 17 new resources tests + 1 CRDT per-open-origin test,
fast lane green (528+), `examples/chat-resources` verified end-to-end. Spec produced by the
wayfinder map at `.scratch/chat-objects/` (designer digest R1–R10 · seam audit G1–G13 · three-lens
adversarial critique). Implementation deviations, all minor: (1) agent tool shape notes are
host-authored strings (`resourceShapes`) — zod v3 has no `toJSONSchema` to render from the contract;
(2) `writeResource` caps ops at 64/request; (3) op paths are STRING object-keys only — array
elements can't be addressed (the CRDT store treats arrays as opaque leaves; replace an array
wholesale at its key), enforced at schema + projection; (4) `writeResource`'s gate reads the exact
registry pk + membership directly — deliberately STRICTER than `resolveResourceAccess`'s any-channel
shape, since the request names its channel; (5) cards carry no `status` field (absent = plain-send
semantics, as everywhere); (6) client presence store is `resourcePresence(collection, docId)`, not
`(docKey)`; (7) kind names must be colon-free (composite-pk segments; boot-checked). Post-build
three-lens adversarial review: 1 HIGH (array-path doc corruption) + 5 lower findings, all fixed or
absorbed above. The OMMA designer migration is the reference consumer
but explicitly NOT this plan's scope.**

## Problem

Channels have messages and members but no shared *objects*. A team (or a human + an agent) working
in a channel has nowhere to put the thing they're working ON — a document, a todo list, a canvas —
with the same access rule as the conversation itself. The concrete consumer: OMMA's designer, where
every chat thread collaborates over a scene doc that is already a super-line CRDT collection, but
whose access today is a session-bound RLS hack (`ctx.session.resourceUUID === id` — one scene per
connection, rebound on every `join`) and whose agent co-writer runs policy-free in-process — the
exact coupling ADR-0051 (pod-per-thread) needs removed.

plugin-chat can't own the schemas (a canvas is the host's type). What it CAN own: the **link
registry** (which docs belong to which channel), **creation** (server-authoritative, host-seeded),
**access** (membership-gated CRDT policies), **lifecycle** (die-with-channel where that's wanted),
and the **agent toolset**. Hosts declare the CRDT collections; chat makes them channel-native.

## Design principles

1. **Host owns schemas; chat is a schema-agnostic registry + access broker.** No built-in resource
   types. Designer's `scenes` stays designer's zod.
2. **Membership is the only gate (v1).** Every member — human, bot, pod-agent — reads and writes
   every channel resource. No per-resource ACLs, no roles.
3. **Registering a kind is the single act**: it enables `createResource`, contributes the
   membership-gated CRDT policies for that collection, and enrolls it in the channel-delete
   cascade. One registration, three effects.
4. **Rows are state** (ADR-0051 alignment): the registry and presence are durable LWW collections —
   the only signal class that crosses nodes in every deployment tier (relay+adapter AND
   self-tier-adapterless; audit G9). Nothing load-bearing rides rooms.
5. **Honest acks for agents**: LLM writers get a request path with synchronous validation errors,
   because `DocHandle` writes are void + optimistic with async-resync-only rejection (G11).
6. **Smallest change**: exactly two core extensions (G1, G6), both small and non-breaking;
   everything else is plugin-chat code over existing seams.

## The lifecycle amendment (supersedes the earlier always-delete decision)

Lifecycle is a property of the **kind**:

- **`owned`** (default) — doc minted by chat, id server-minted (UUID), belongs to exactly one
  channel, deleted on detach and on channel deletion. No orphans in steady state (the
  create-crash window is a G10-class accepted risk).
- **`linked`** — doc id host/client-suppliable (designer's persistent scene id IS an Omma content
  UUID), attachable to **multiple** channels, detach/cascade remove only registry rows — chat
  never deletes the doc.

Why amended: persistent scenes are user CONTENT, outlive every conversation, and are shared by many
conversations (verified in the tomorrow repo) — always-delete would destroy user documents.

## New surface

### Contract — `chatContract()` grows two LWW collections + four requests

```ts
// resources — the link registry. Composite pk makes duplicate attach structurally impossible.
resources: {
  id: string          // `${channelId}:${kind}:${docId}`
  channelId: string   // references: channels
  kind: string
  collection: string  // denormalized from the kind at write time — rows self-describe what to open
  docId: string
  title: string       // immutable in v1 (no updateResource — deferred until a real need)
  createdBy: string   // references: users
  createdAt: number
}

// resourcePresence — coarse who's-open. Doc-scoped, NOT channel-scoped (a channelId field would
// LWW-clobber on the multi-channel linked case — critique-caught).
resourcePresence: {
  id: string          // `${collection}:${docId}:${userId}`
  docKey: string      // `${collection}:${docId}` — the read-filter key
  collection: string
  docId: string
  userId: string      // references: users
  openedAt: number
  heartbeatAt: number
}
```

Requests (`shared.clientToServer`):

```ts
createResource:   { channelId, kind, title?, id?, params? } → ResourceRow
detachResource:   { channelId, kind, docId }                → ResourceRow   // the removed row
writeResource:    { channelId, kind, docId, ops }           → { snapshot }  // acked doc write
announceResource: { kind, docId, state: 'open'|'heartbeat'|'close' } → { ok: true }
```

`ops: Array<{ path: string[], set: unknown } | { path: string[], delete: true }>` — mirrors
`DocHandle.update`/`delete(path)` per-property merge semantics for OBJECT keys; array elements are
not addressable (opaque CRDT leaves — set the whole array at its key). No whole-snapshot replace
(clobbers concurrent editors).

Collection names are unprefixed (house style). A host collection named `resources` /
`resourcePresence` now collides → the existing loud `defineContract` throw. `metadata.resource` on
messages becomes a RESERVED key (doc-comment on `messageSchema`, the `metadata.bot` precedent).

### Server — the kind registry on `chat()`

```ts
chat({
  contract,
  resources: {
    kinds: {
      todo:   { collection: 'todos', init: () => ({ items: [] }) },            // owned (default)
      canvas: { collection: 'scenes', lifecycle: 'linked',
                init: async (c) => flattenScene(await loadBundle(c.params)) }, // host validates params, throws VALIDATION
    },
  },
})
```

- `init(c: { channelId, kind, id, title, params, userId, ctx }) => Awaitable<Doc>` — async, host
  code. `params` is opaque (`Record<string, unknown>`); the HOST is the validator (no param-schema
  registration in v1).
- **Registered kinds' schemas must be presence-tolerant (ADR-0008)**: concurrently-edited fields
  need `.catch()`/`.optional()` — a rejected concurrent write hard-resets a co-writer's doc to a
  transiently partial state, and validate-before-commit can't require a field a concurrent merge
  may drop. `required` is safe only for set-once-at-`init` fields. This is a documented contract on
  `resources.kinds`, same as for any CRDT collection.
- The chat plugin contributes, per registered kind, the CRDT policy for that collection (needs G1):

```ts
// one shared helper — used by BOTH policies and the writeResource gate (critique: never two copies)
resolveResourceAccess(collection, docId, uid): Promise<string[]>   // channelIds granting access
read:  async (_p, id, _snap, ctx) => { const uid = uidOf(ctx); return !!uid &&
         (await intersects(resolveResourceAccess(col, id, uid), channelIdsOf(uid))) }
write: same shape (no snapshot needed — the registry lookup IS the gate; R4/G12)
```

  Unattached docs: no registry row → policy denies — invisible through chat. **G4 consequence,
  documented in `resources.kinds` JSDoc**: a host `policies` entry for a registered kind's
  collection throws at boot ("registration is the policy") — the runtime collision message is
  generic, so the JSDoc carries the remedy.
- `chatKit.resources` imperative kit (parity with channels/members/messages): `create`, `detach`
  (same domain cores as the requests — hooks fire), `of(channelId)`, `sweepPresence({ olderThanMs })`.
- `ChatHooks` gains `createResource` / `detachResource` / `writeResource` before/after entries.
  `announceResource` is deliberately hook-free (heartbeat cadence — the `appendMessage` precedent).
- Implementation note: `PluginContext.collection()` is statically the LWW handle; CRDT access uses
  the plugin-inspector cast pattern (`as unknown as ServerCrdtCollectionHandle`). `.delete(id)`
  happens to be shape-compatible uncast.

### Request semantics (the load-bearing algorithms)

Both `createResource` and `detachResource` run under the SAME `withChannelLock(channelId)` as the
channel-delete cascade — that lock, not the catch-CONFLICT dance, is what closes the
create-vs-cascade race (a create can't slip rows in behind the cascade's snapshots). Same
single-node caveat as every existing use of that lock.

**`createResource`** — membership required; kind must be registered.
- owned: `id` input FORBIDDEN (`VALIDATION`); id = server UUID; run `init` → `create(id, data)` →
  insert registry row.
- linked: id = supplied ?? server UUID. **Create-or-attach is catch-driven, never a pre-check**
  (TOCTOU — critique): try `create` — catch `CONFLICT` → doc exists, skip init; try row insert —
  catch `CONFLICT` → already attached, return the existing row as success. Two racing tabs both
  succeed (R5).
- Order: doc BEFORE row — invariant: *a registry row's existence implies its doc exists*. Deletion
  is the mirror: rows BEFORE docs (crash leaves an invisible orphan doc, never a dangling row).
- On success (fresh create or fresh attach): emit a resource card (below).

**`detachResource`** — membership required. Delete registry row; owned → also
`srv.collection(col).delete(docId)` (real `cddel`/`onDelete` fan-out flips every open client's
`deleted`). Linked → row only. Card emitted.

**`writeResource`** — the acked write path (agents + any client wanting sync errors):
1. Gate on the exact `(channelId, kind, docId)` registry triple via `resolveResourceAccess` +
   membership (critique: membership+kind alone would let a member write ANY doc of the collection —
   `srv.collection` bypasses policy, so the handler must re-prove what the policy proves).
2. Validate on a JSON projection: read snapshot → clone → apply ops → `def.schema` parse. Failure →
   `SuperLineError('VALIDATION', zodMessage)` — lands verbatim as the agent's tool error.
   (Critique catch: server co-writer replicas do NOT validate — validate-before-commit is
   client-delta-only. This projection check is best-effort honest-error reporting; the tiny
   validate→apply race is accepted; server co-writes remain authoritative by design.)
3. Apply ops via `srv...open(docId, { origin: `user:${userId}` })` (attribution without G6), close,
   return the post-write snapshot.

**`announceResource`** — access via `resolveResourceAccess` (any granting channel). open → upsert
row; heartbeat → bump `heartbeatAt`; close → delete row. Liveness = recency: clients filter
`now − heartbeatAt < 45s` (helper does it); recommended heartbeat 20s. Reaping is host-invoked
`sweepPresence` (the `sweepStale` pattern — no plugin timers). Keyed by user, not connection: no
per-tab granularity, no onDisconnect bookkeeping; crashed tabs age out. Presence rows for detached
docs turn invisible via the read filter and are reaped later — no active cleanup.

### Policies (row side)

- `resources.read`: `isIn('channelId', channelIdsOf(uid))` — the messages shape.
- `resourcePresence.read`: `isIn('docKey', docKeysOf(channelIdsOf(uid)))` — registry lookup at
  subscribe time; same capture-at-subscribe staleness class the plugin already accepts.
- Both `write: undefined` (deny) — every mutation rides a request. House stance unchanged.

### Access staleness — accepted and documented

A linked-detach does NOT evict a reader whose doc is already open (CRDT read policy runs at
`cdopen` only — G12). This matches the existing accepted staleness of captured-at-subscribe row
filters for removed members. Hard revocation today: `toUser(userId).disconnect()` (the
`authKit.revoke` pattern) — reconnect re-runs every policy. A narrow per-doc-channel eviction
primitive is DEFERRED (fog).

### Resource cards

`createResource`/`detachResource` send a regular message through the sendMessage core (hooks +
moderation see it): `authorId` = acting user, **`content` absent** (legal — the streaming-envelope
precedent), no `status` (absent = plain send), `metadata.resource = { action:
'created'|'attached'|'detached', kind, docId, title }`. Durable, in-history, renderable. **`onChatMessage` skips
`metadata.resource` messages** so cards never trigger bot turns (critique catch — otherwise every
attach fires every bot in the channel).

### Client + react

- `chatClient`: `resources(channelId)` → `ChatLiveStore<ResourceRow>` (rides the existing
  membership-watcher re-subscribe), `resourcePresence(docKey)` helper, and
  `createResource/detachResource/writeResource/announceResource` wrappers.
- Doc opening stays NATIVE: `client.collection(row.collection as CrdtCollectionName<C>).open(row.docId)`
  / `@super-line/react`'s `useDoc`. plugin-chat ships NO doc-open wrapper (critique: avoids a new
  `@super-line/react` dependency and an unsound cast).
- react adds `useChannelResources(channelId)` and `useResourcePresence(row)` (auto-announce on
  mount, heartbeat, close on unmount, returns recency-filtered member list) — hand-rolled over
  `ChatLiveStore` like the existing hooks.

### `/ai` toolset

`chatAgentTools` grows: `list_resources` (one-shot subscribe→rows→close), `read_resource`
(snapshot JSON, ~16KB cap + explicit truncation notice), `create_resource`, `detach_resource`,
`write_resource` (the request; zod `VALIDATION` text is the tool error the model reads). Tool
descriptions embed a compact rendering of each kind's collection schema read from the contract
client-side. All tools run over the agent's own connection — the server re-authorizes everything.

## Core extensions (this repo, both small)

- **G1** — widen `SuperLinePlugin.policies` (`packages/server/src/index.ts:324`) value type to
  `CollectionPolicy<unknown, unknown> | CrdtCollectionPolicy<unknown, unknown>`. Compile-time only;
  the runtime merge is already shape-agnostic. The per-collection discriminated alternative is
  REJECTED (requires threading fragment collections into the plugin type — breaking for all plugin
  authors).
- **G6** — per-open client origin: `CrdtCollectionHandle.open(id, opts?: { origin?: string })`
  threaded through `crdtCollectionsClient` (the one universal client engine) into the existing
  `cdwr.o` wire field. **Untrusted** — echo-break + inspector/CC attribution only, never a policy
  input (spoofable). Optional nicety for host agent clients; the `/ai` path doesn't need it.

## Inspector / Control Center

Nothing new required: `resources`/`resourcePresence` browse as ordinary row collections; resource
docs already surface through the synthetic-id CRDT path in `listCollections`/`queryCollection`;
`writeResource` traffic appears via the existing `crdt.write` taps with the `user:<id>` origin. A
chat-flavored "Resources" affordance in CC is deferred.

## Requirements coverage (vs `designer-requirements.md`)

| Req | Verdict |
|---|---|
| R1 membership-gated access | ✓ auto-policies per kind; agents pass as members |
| R2 discoverable registry | ✓ `resources` collection + live stores |
| R3 canvas can't be owned/deleted | ✓ `linked` lifecycle |
| R4 host-supplied ids → lookup guards | ✓ `resolveResourceAccess` in policies + writeResource |
| R5 async init, params, race→attach | ✓ catch-CONFLICT create-or-attach |
| R6a client write attribution | ✓ G6 (untrusted) + server-side origin on writeResource |
| R6b rejectable-write survivability | ✓ documented; ADR-0008 presence-tolerant schemas |
| R7 adapterless multi-node | ✓ registry/presence/cards are rows; nothing load-bearing on rooms |
| R8 resource cards | ✓ metadata.resource messages |
| R9 DocHandle suffices | ✓ native open; no wrapper |
| R10 migration concerns | out of scope by design; enumerated for the migration effort |

## Phases

1. **Registry + access** — G1 widening; `resources` collection + policies; kind registry;
   `createResource`/`detachResource` cores + requests + hooks + cascade (rows-then-docs inside
   `deleteChannelCore`'s lock, creates/detaches under the same lock); `chatKit.resources`;
   client side: `chatClient.resources(channelId)` store + `createResource`/`detachResource`
   wrappers + react `useChannelResources`; loopback tests: policy matrix (member/non-member ×
   read/open/write), create-or-attach races (two concurrent creators, create vs cascade),
   owned/linked detach semantics, cascade completeness, G4 collision boot-throw.
2. **Writes + agents + cards** — `writeResource` (gate + projection-validation + replay + snapshot)
   + its client wrapper; resource cards + `onChatMessage` skip; `/ai` tools incl.
   schema-in-description and truncation; tests: validation error text reaches the tool, gate
   rejects non-attached docId, concurrent client delta during writeResource, cards don't trigger
   bots.
3. **Presence + polish** — `resourcePresence` + `announceResource` (+ wrapper) + `sweepPresence` +
   react `useResourcePresence`; G6 per-open origin; docs (how-to page + concepts
   note + plugin-chat README + skill update); example: `examples/chat-resources` — a shared todo
   list (`owned`) + a tiny canvas (`linked`, host-id) with a bot member exercising
   `write_resource` end-to-end.

## Deliberately open (implementation-time, not design forks)

- Exact `resolveResourceAccess` caching (none in v1 — G12 says two local reads per check is fine).
- `read_resource` truncation strategy detail (bytes vs depth); card text for plain clients.
- Whether `chatKit.resources.create` accepts a precomputed doc (host already made it) — lean no.

## Deferred (fog on the map, post-v1)

Per-doc-channel eviction primitive (hard read revocation on linked-detach) · `updateResource`/
rename · live cursors/selections (reopens the ephemeral-transport question — their SL-2) ·
`listResourceKinds` introspection · per-connection presence granularity · param schemas on kinds.

## Reversed / narrowed during the map

- **Always-delete + single-channel ownership → per-kind `owned`/`linked`** (overturned by designer
  evidence: persistent scenes are Omma user content, shared across conversations).
- `writeResource` "validate-before-commit" claim → **projection-validation** (server co-writer
  replicas don't validate; critique-verified).
- `attachResource`/`updateResource`/`listResources` requests, `useResourceDoc`, registry
  `metadata` field, presence `channelId` — all cut (critique/minimalism).
- "Presence in v1" narrowed to coarse who's-open; cursors explicitly deferred (designer parity
  today is zero presence).
