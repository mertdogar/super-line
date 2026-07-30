# Context — super-line

A glossary of super-line's domain language — grown from the persisted-state (Store) design, now covering composition/embedding too. Terms only — no implementation details. Updated inline as decisions crystallise during design.

## Glossary

### Principal (the ACL identity)
Resolved 2026-06-23. The identity a Resource's `accessRules` are keyed by, and the thing the server checks a caller against on read/write. **Reuses the existing `identify(conn)` hook**, with a fallback: `principal = identify(conn) ?? conn.id`. This makes the principal **always defined** (no anonymous-undefined case in the ACL code). Tradeoff: `identify` configured → stable principal → grants survive reconnect; `identify` absent → the random per-connection `conn.id` is the principal → grants live only for the connection's lifetime (stable-anonymous identity is an app concern: client generates an id, passes it via handshake params, `identify` reads it). Verified 2026-06-23: super-line does NOT currently assign any fallback — an `identify`-less conn is fully anonymous (no user channel, no `userId` in presence). This fallback is **new behaviour to add**. Distinct from [[Replica origin]].

### Replica origin
Resolved 2026-06-23. The `origin` on a `DocChange`: a **per-replica/per-connection writer id**, owned by the CRDT client engine (`crdtCollectionsClient`, which stamps it on every delta it emits) and **opaque to super-line core** — used only for echo-break and attribution. Explicitly **NOT** the [[Principal (the ACL identity)]]: two tabs of the same user share a principal but have distinct origins, so each receives the other's edits (the canonical multiplayer case). Also **NOT** the CRDT-internal actor id (Yjs/Automerge assign that inside super-store for merge math). Three identities, three jobs — principal (*may* this writer write), origin (*whose* update, for echo-break), CRDT actor (merge math).

### Clustering mode (relay | self)
Resolved 2026-06-23. A capability the **collection backend declares** (ADR-0009), telling super-line core how cross-node sync happens for it. `relay`: the backend is node-local (zero networking); **core relays changes across nodes over the existing adapter**, feeding an arriving change into the node's local backend (symmetric write) + local subscribers, echo-broken by [[Replica origin]] and node identity. Each node holds a replica (the synced-state pattern, formalized). `self`: the backend talks to a **shared backend** (central Postgres + Electric) that is canonical truth and handles its own cross-node consistency; core fans changes only to local subscribers and does not relay over the adapter. `collections-memory` / `-sqlite` are `relay`; `collections-pglite` is `self`. Cost: core and the interface carry two code paths.

### super-store (the CRDT engine, two layers down)
A separate WIP library at `/Users/mertdogar/Workspace/personal/super-store` (`@super-store/store`): a single Yjs-backed reactive primitive `StoreValue<T>` (one value, `set`/`update`, payload-less `subscribe`+`getSnapshot`, opt-in undo, Yjs convergence). **Not** a super-line Store — no `id`/`accessRules`/collection/list/ACL/cross-node. It is the **engine a future `CrdtStore` implementation of super-line's Store interface will wrap** to hold one Resource's `data`. Layering: super-line `Store` → `CrdtStore` impl → `super-store StoreValue`.

### Co-writer
A participant — the server *or* a client — permitted to mutate a Shared Document. In this design **both the server and clients are co-writers with equal write reach**: there is no partition, either party may mutate any field. (Resolved 2026-06-23: user confirmed both parties mutate anywhere in the state, no server-owned vs client-owned regions.)

### Surface (contract fragment)
Resolved 2026-07-03. An **exportable fragment of a contract** — one `Directional` (`clientToServer` + `serverToClient` maps) that a super-line-powered library ships for a host app to mount into *its own* contract. Authored via `defineSurface` (which preserves literal keys and `subscribe: true` the way `defineContract` does inline — without it a separately-declared fragment silently degrades topics to events) and combined via `mergeSurfaces`, where a **duplicate key is a compile error naming the key** (plus a runtime throw), never a silent spread-clobber. A Surface carries no roles and no `data` schema — those belong to the host. The unit of [[Composition (embedding)]].

### Composition (embedding)
Resolved 2026-07-03 (ADR-0004). How one super-line-powered library rides inside a host app: **one server, one client, one session, one identity** — the library exports [[Surface (contract fragment)]]s plus its handlers and store configs; the host weaves them into its contract, `implement`, and `stores`, and owns roles, `authenticate`, `identify`, and middleware. **Namespacing is a key-prefix convention, not a wire feature**: the library hard-prefixes its request/event keys, store names, and room names (e.g. `harness.join`) in its own source. Chosen over Socket.IO-style connection namespaces and over a mux transport (two independent sessions on one socket — deferred, `PLAN-transport-mux.md`) because the driving requirement was *shared identity*, which composition gives by construction. Distinct from [[Transport vs Adapter]]: composition happens above the wire entirely.

### Plugin (runtime bundle)
Resolved 2026-07-04. A **named bundle of runtime contributions** registered with the server in one place (`plugins: [...]`) — a [[Tap (node-local observation)]], lifecycle hooks, middleware, request handlers, named stores — every part optional. One concept serves two audiences: an *operator plugin* is tap-only (metrics/audit/tracing); a *library plugin* is the runtime half of [[Composition (embedding)]]. A Plugin is **runtime-only by constraint**: end-to-end types hang off the contract object, so a library's typed surface cannot ride inside a Plugin — it ships a Plugin **paired with** a [[Surface (contract fragment)]] the host still merges explicitly — and the pairing is typed: a Plugin is declared over its Surface, so plugin-covered contract keys are subtracted from the host's `implement` obligation at compile time (forgetting the plugin, or double-implementing its keys, stays a compile error, per the mergeSurfaces discipline). Distinct from the four pluggable seams ([[Transport vs Adapter]], Store, Serializer), which *implement* super-line's interfaces; a Plugin *contributes into* the host app. Dissolves the singular-hook collision (two concerns can now both observe connections/errors without hand-composition). Ships as a **pair, exactly like a Transport or a Store** (resolved 2026-07-04): a server half and an optional client half — the client half bundles the library's client store configs, its server→client request handlers, and connection-lifecycle callbacks (which the client grows for the first time via this design); an operator plugin is typically server-only. The React layer needs no plugin awareness — it rides the client's public surface. **Acceptance test (committed 2026-07-04): the inspector + Control Center must be expressible as a Plugin** — phase 1 makes the inspector the first internal consumer of the Tap; phase 2 adds plugin-owned connections and extracts it fully.

### Tap (node-local observation)
Resolved 2026-07-04. The observation capability of a [[Plugin (runtime bundle)]]: fired **synchronously on the node where the operation happens**, receiving live payload references (observer must not mutate) — no snapshotting, no envelope, zero cost when no plugin taps. Deliberately node-local: cluster-wide views are **built by plugins, not provided by the Tap** — a plugin composes local taps with adapter/bus access to ship events across nodes (the inspector's own pattern). The event vocabulary is the inspector's existing taxonomy (connect/disconnect, room/topic lifecycle, `msg.*`, `store.*`). Distinct from middleware (an inbound *gate* that can reject): a Tap only observes, and may react by initiating new operations — never veto or transform in-flight ones. **Server-side by construction**: the client's mirror is a [[Client-side tap]], which is deliberately not the same vocabulary.

### Plugin provenance
Resolved 2026-07-23 (ADR-0016). The record of which [[Plugin (runtime bundle)]]'s contract fragment contributed each collection and surface key to a merged contract. `defineContract` merges fragments by intersection, so provenance previously existed only as an input and was discarded at merge — leaving an observer unable to tell a host's own request from a plugin's. It is now retained on the merged contract, and paired on the inspector wire with the **runtime** plugin list (those actually registered on the server). The two halves are independent: a plugin may contribute runtime behavior with no fragment (the inspector itself), and a fragment merged without its server half registered is a misconfiguration that provenance makes visible for the first time.

### Identity lens (Control Center)
Resolved 2026-07-23. The Control Center's presentation of authenticated connections: the `userId` on a connection descriptor joined against the auth plugin's user directory, so connections read as people (display name, roles, metadata) rather than opaque ids. It is the observer's **editorial** view — held by the Control Center, keyed on [[Plugin provenance]], and requiring no extra API surface from the auth plugin. Deliberately a join and not extra fields on the descriptor: a descriptor is stamped at connect and would go stale on rename, and a directory row carries host-opaque metadata that has no business crossing the presence store. Kept fresh from the existing collection-change feed rather than a new subscription seam.

### Transport vs Adapter
Two distinct pluggable seams, never conflated. A **Transport** carries client↔server bytes — the wire (WebSocket default; also HTTP-SSE, libp2p, loopback). An **Adapter** carries server↔server, node-to-node fan-out (Redis, libp2p, RabbitMQ, ZeroMQ). A `relay` store (see [[Clustering mode (relay | self)]]) rides the Adapter for cross-node sync; a `self` store owns its own central backend and needs no Adapter.

### Collection runtime
Resolved 2026-07-13. The server-side authority for contract-declared **Collections**, spanning both consistency models: LWW rows and CRDT documents. It is one Collection concept with mode-specific behavior, not a merger of the row and CRDT persistence seams.

### Collection batch
Resolved 2026-07-13. An atomic, ordered set of LWW row mutations across one or more Collections. Each mutation observes the effects of earlier mutations in the same batch; CRDT document mutations never participate.

### Collection policy
Resolved 2026-07-13. A deny-by-default, retry-safe authorization predicate governing client access to a Collection. A Collection policy decides access without producing effects; server-authoritative writes do not pass through it.

### Change source
Resolved 2026-07-13. The attribution attached to an LWW row change: the client Principal, `server`, or `plugin:<name>`. Distinct from a CRDT [[Replica origin]], which identifies one replica for echo-breaking.

### Cluster (node identity over the Adapter)
Resolved 2026-07-15. A thin module over the [[Transport vs Adapter]] Adapter owning the one fact every cross-node frame carries: **which node published it**. It stamps that id outbound, encodes/decodes through the Serializer, and reports `own` inbound — so no call site hand-rolls `frame.nd === instanceId`. Before it, one concept had three mechanisms and two spellings (`nd` on collection/CRDT frames, `i` on bus/plugin-channel frames, plus the CRDT `relaying` flag) across nine sites.

It owns **detection, never policy**, because there are two correct [[Local delivery strategy]] choices and which one a caller made decides what `own` means to it. It also hands back the **raw bytes** beside the decoded frame, because CRDT fan-out relays them straight through (`conn.sendRaw`) — one pre-encoded buffer to N connections. That is why the id is stamped **into** the frame rather than wrapped in an envelope: an adapter payload must stay a valid client frame (`nd` is declared on client-visible frame types, documented as ignored by clients). The field is **node-local** — each node recognises only its own stamp — so a mixed-version cluster stays correct.

Distinct from the Adapter (carries the bytes; guarantees the loopback) and from [[Replica origin]] (a per-*writer* id that survives relay, and so cannot stand in for node identity).

### Local delivery strategy
Resolved 2026-07-15. How a node gets a cross-node message to its *own* subscribers. super-line has two, both correct, and the choice decides the echo-break policy — which is why [[Cluster (node identity over the Adapter)]] reports `own` rather than acting on it:

- **deliver-at-source** — fan out to local listeners at publish time, then *drop* the looped-back copy. Used by the cluster bus, plugin channels, and row [[Collection runtime]] relay. Rows have no choice: `store.onChange` fires on the writing node at apply time, and a `self` backend never publishes at all.
- **deliver-on-receipt** — do *not* deliver locally on publish; let the Adapter's guaranteed loopback come back and fan out on arrival. This is the Adapter's own documented design ("a node delivers to its local members on receipt — one code path, no double-send"), used by rooms/topics and by CRDT document relay, which forwards the frame **regardless** of `own` and uses `own` only to skip re-applying its own delta.

A Cluster that quietly filtered own-messages would break every CRDT client's local delivery. The asymmetry is pinned by `packages/server/test/collections-cross-node.integration.test.ts`.

### Relay-sync invariant
Resolved 2026-07-15. A **`relay` backend's `apply` must be synchronous** — for both [[Collection runtime]] families. The relay ingress path fires-and-forgets (`void apply(...)`) so a cross-node race lands in a `try`/`catch`, and the CRDT side guards re-publish with a flag cleared in `finally`; an async `apply` escapes that catch and clears that guard before the change is emitted, turning one relayed write into a cluster-wide echo storm. [[Replica origin]] cannot substitute for the flag: it identifies the *writer* and survives the relay, so a receiving node cannot distinguish a relayed delta from a local write by that same writer. A `self` backend is exempt — it never relays. The rule was real and load-bearing but recorded only in `collections-crdt-libsql`'s private doc comment (that backend keeps its hot path sync and persists off `onChange` for exactly this reason); it now lives on `CollectionStore.apply` / `CrdtCollectionStore.apply`. Expressing it in the type system — splitting each seam into a discriminated union on `clustering`, which already discriminates — is the real fix and is still open (breaking; core + 6 backends; wants an ADR).

### Credential
Resolved 2026-07-17. The **durable stored secret** that proves a connection's identity: a **password hash**
(`credentials` collection) for a human, an **API key** for a bot. Verified at login/connect. Distinct from a
[[Access token]] (which is issued *after* a credential is verified), from a [[Bearer assertion (JWT)]] (which
is stored nowhere at all) and from [[Connection ctx (identity)]]
(the resolved identity, not the secret).

### Access token
Resolved 2026-07-17, renamed 2026-07-23 (was "Session token"). A **re-sendable substitute for a password**,
issued once a [[Credential]] is verified, so a human's browser can reconnect without re-sending the password —
and so a login can be revoked without changing the password. **Humans only.** A bot needs none: its **API key
is already a safely-re-sendable durable credential**, so `sessionId: null` on an API-key connection is correct,
not a gap. Renamed because "session token" collided with [[Connection session]] — a different concept that a
token-authenticated connection also creates — and because the code has always called it `accessTokens`. It is
a **lookup key**: whoever validates it needs the database, which is precisely what a [[Bearer assertion (JWT)]]
does not require.

### Bearer assertion (JWT)
Resolved 2026-07-23. A **short-lived claim about identity that is stored nowhere** — the only credential here
that authenticates without a server-side secret to look up, so it sits outside [[Credential]] by definition.
Verification is a key operation, not a database read, which is why a service holding only the key (no
super-line, no database) can trust it. The trade-off is symmetric and unavoidable: nothing is stored, so
nothing can be revoked — `revoke(userId)` cannot reach it and short TTLs are the mitigation. The **one
deliberate dent** is a user read at connect, which makes `users.deactivate()` an emergency stop. Comes in two
kinds — [[Signed assertion]] and [[Sealed assertion]] — which share one handshake param (`params: { jwt }`,
dispatched on the compact dot count) because RFC 7519 admits a claims set in either serialization. Distinct
from an [[Access token]] (stored, revocable, a lookup key) and from a [[Connection session]] (which an
assertion connection still creates).

### Signed assertion
Resolved 2026-07-23 (ADR-0015). The **JWS** kind: a bearer assertion whose payload is **public by
construction** — base64, readable by anyone holding the token, checkable by anyone holding the verification
key. That readability *is* its purpose: it is the kind another backend verifies statelessly. **Server-minted
only** (`authKit.tokens.mintSigned`; the client mint was retired 2026-07-24), so its `claims` are
**server-authored** — the difference from a sealed token is readability, not trust. Carries its own `roles` and stamps `authMethod: 'jwt'`.

### Sealed assertion
Resolved 2026-07-23 (ADR-0015). The **JWE** kind: a bearer assertion that is **opaque to its own holder**.
Carries a public `claims` bag and a `sealed` bag, both readable only by a party with the encryption key —
so it is the only credential here that can carry a secret *through* the client that presents it.
**Server-minted only** (`authKit.tokens.mintSealed`), like every assertion since the 2026-07-24 update; what
sets it apart is that its payload is opaque even to its own holder — letting it carry a secret *through* the
client — whereas a [[Signed assertion]]'s `claims` are readable by whoever holds it. Its roles come from
the user row at connect, not from the token — making it "a stateless [[Access token]] that carries a typed
payload" — and it stamps `authMethod: 'jwt-sealed'`. Its public half reaches the client only via
[[Connection env]], never automatically.

### Connection session
Resolved 2026-07-17. A **live connection plus its server-side state**. Every authenticated connection has one —
bots included. Its server-only identity is [[Connection ctx (identity)]]; its client-visible slice is
[[Connection env]].

### Connection ctx (identity)
Resolved 2026-07-17. The **frozen, server-only identity** a connection authenticated as (`{ userId, roles,
sessionId }` under plugin-auth) — the value `authenticate` returns as `ctx`, stashed `readonly` on `conn.ctx`
and used as the **trusted input to authorization** (handlers, row policies). Server-only and frozen for two
reasons: authz must key on an unchanging, unforgeable identity, and hosts stash *server-only* per-connection
state here. The opposite corner of the visibility×mutability grid from [[Connection env]] — the two are
**paired at the source** (`authenticate → { role, ctx, env }`) but never merged.

### Connection env
Resolved 2026-07-17 (ADR-0012). A **typed, per-connection, server-vended, client-visible, mutable, ephemeral**
state bag — the visibility-mirror sibling of `conn.data` (*"`data` is server-side scratch; `env` is the same,
but the client sees it"*). Declared per role on the contract (`roles.R.env`), seeded by `authenticate`
alongside [[Connection ctx (identity)]], updated live via `conn.setEnv` / `srv.toUser(id).setEnv`, read on the
client as `client.env` (`current`/`ready`/`subscribe`) / React `useEnv()`. super-line is a **pure courier**: it
validates and delivers the payload but never interprets, acts on, or attributes it (no impersonation, no
on-behalf-of). **Never persisted** — it holds live external credentials and lives only in memory, re-seeded on
reconnect. Its intended use is an agent's *runtime* wiring the creds into its tool implementations (the LLM
never sees it). Surfaced in the Control Center (`ConnView` + an `env.set` feed event) **masked by default** —
values hidden unless a key is host-allow-listed (`revealEnvKeys`) — because `env` always holds creds. Distinct
from a collection (persisted, policy-gated) and from a [[Collection policy]] (authorization, not delivery).

### Settle (streamed message)
Resolved 2026-07-19 (ADR-0014). The transition of a streamed message from `streaming` to a **terminal status** (`complete` · `aborted` · `error`), exactly once. Carries the invariant **a streamed message always settles before it vanishes**: deleting a still-streaming message (or its channel) settles it first, so a consumer may treat any non-`streaming` status as a reliable turn boundary, and the settle signal always releases the producer's stream handle — whoever deleted, from whichever node. Cancellation, deletion, disconnect, kill-switch, caps, and shutdown drain are all expressions of the same settle; the producer never finalizes after one lands (a settle is server-authoritative and happens once).

### Framing chunk
Resolved 2026-07-19. An adapter-recognized stream chunk carrying **no transcript content** — run/step boundaries and message metadata. Known framing is dropped from the durable transcript, but the host's `mapDataPart` gets **first refusal** before the drop, because host-relevant payloads (token usage above all) ride framing; unmapped framing drops silently and is never reported "unsupported". Distinct from dropped *content* chunks (streaming tool args), which stay adapter-owned and are never offered.

### Auth domain hook
Resolved 2026-07-23 (ADR-0017). A `before`/`after` pair around one of plugin-auth's **server-invoked operations** (`hooks: { authenticate: {…}, apiKeys: { create: {…} }, … }` on `auth()`) — the host-extension seam for connection admission and server-initiated identity mutations (agent provisioning, admin user management, key/token minting). The line is *who invokes the op*: `authenticate` (host-wired) and the imperative kit (`authKit.users.*` · `credentials.*` · `apiKeys.*` · `tokens.*`) are hooked because they have no other seam; the client request handlers (`signIn`/`signUp`/…) are **not**, because `use:` middleware already vetoes them (ADR-0017). Two shapes: kit ops are `AuthOpHook<In,Out>` (`before` transforms/vetoes, `after` observes) — **except** `users.deactivate` whose `before` is non-vetoable (throw → `onError`, op proceeds; a safety op must never be blockable); `authenticate` is richer — its `after` may **transform** the resolved `AuthResult` (enrich `ctx`, override `env`) or reject (throw), since it commits nothing. Unlike plugin-chat's `ChatOpHook` (ADR-0010) it carries **no initiator** (every hooked op is server-invoked) and its payloads carry **raw secrets** (bearer tokens in `authenticate.before`, plaintext passwords in `credentials.*.before`, minted keys/tokens out of `apiKeys.create`/`tokens.*` `after`). Reads are unhooked. Distinct from [[Tap (node-local observation)]] (observe-only) and from middleware (gates client requests by name but sees no body and no result).

### Silent cascade
Resolved 2026-07-23 (ADR-0017). When an auth operation internally revokes downstream state — `users.deactivate` flushing a user's API keys + sessions, `credentials.setPassword` revoking tokens — those internal writes fire **no** per-op [[Auth domain hook]]s; only the composite's own hook fires. A host wanting a complete revocation audit hooks the composite, not the leaves. The auth counterpart of chat's `deleteChannel` cascade, which likewise deletes memberships/messages via raw writes, not through their per-row cores.

### Credential source
Resolved 2026-07-25. The app-supplied answer to *"what credential should this client connect with?"* — `resolveToken` when set, otherwise the persisted [[Access token]] in `storage`. Deliberately **not** a boot hook: boot is merely its first consultation and a re-authentication is a second, which is what collapses account switching, post-expiry re-acquisition, and retry-after-rejection into one operation instead of three. It yields a credential or `null` — and `null` is a deliberate answer (*"there is none right now"*), not a failure. It never yields an identity: only the server may assert that, on the connection the credential opens.

### Reserved-connection admission
Resolved 2026-07-28 (ADR-0022). Who decides whether a [[Plugin (runtime bundle)]]-owned connection class may be
entered. A reserved connection is admitted **without consulting the host's `authenticate`** — that short-circuit is
what lets a plugin serve a parallel contract to clients the host's own contract knows nothing about, and it is
also why the Control Center channel could be opened by anyone able to reach the port. Admission is now the
**declaring plugin's** decision, taken at the handshake and expressed in the host's own idiom: reject by throwing,
otherwise return the connection's [[Connection ctx (identity)]]. The **role is deliberately not the plugin's to
state** — it is fixed when the class is declared, because a class that could name its own role could name a *host*
role and mint a connection the host never authenticated. A rejection is delivered as a **close on an established
socket, not a refused upgrade**, because a browser can observe the first and cannot observe the second: telling
"wrong credential" apart from "server unreachable" is a client requirement that the server-side idiom has to bend
to. Distinct from a [[Credential]] (the stored secret being checked) and from the host's `authenticate` (which
governs contract roles and never sees a reserved connection at all).

### Session replacement
Resolved 2026-07-25 (ADR-0020). A client's identity change, expressed the only way super-line allows — **tearing one connection down and opening another**. Role and credential are frozen at connect, so "log in", "log out" and "switch accounts" are the same operation, and the client-side auth helper is the machine that owns it. Governed by one rule: **a replacement never destroys a session it could not replace.** The candidate connection is built and confirmed before the incumbent is closed, so a [[Credential source]] that throws, or a credential the server refuses, leaves the live session running and surfaces an error instead. Only a `null` from the source drops to guest. Distinct from [[Connection session]], which is the *server's* view of a single live connection — a replacement ends one and begins another.

### Worker binding
Resolved 2026-07-28 (ADR-0023). The attachment of an implementation to a declared queue — separable from the declaration, and **node-local**. A queue names its input, its result and its concurrency wherever the contract lives; the function that runs a job may be bound there or later, through the queue's own handle, so the implementation is free to live in the package that owns the server rather than the one that owns the contract. The consequence is a queue that is **declared but unbound *here***: it accepts work and it is visible, but this node will not claim it. That is deliberately not an error — the same shape that lets a worker arrive a moment late lets a node be enqueue-only forever, with peers doing the running. What a node does *without* a binding is the tell: it still recovers work abandoned by a dead peer and still turns schedules into jobs, because neither is execution. Distinct from [[Plugin (runtime bundle)]] registration, which is what makes the queue runtime exist on a node at all; binding decides only which of its queues that node will run.

### Client-side tap
Resolved 2026-07-28 (ADR-0024). The observation seam on the *client* — the mirror of [[Tap (node-local observation)]] rather than an instance of it. It carries a different vocabulary for a structural reason, not a stylistic one: the server's taxonomy is written in terms a client does not possess (connection id, role, target, origin node), while the things worth watching on a client are precisely the ones that never reach the wire — a request created but never sent, a delivery that found no listener, a row change a subscription re-filtered away, a reconnect still counting down. So it emits the wire frame **verbatim** plus a small union of client-local decisions, and leaves correlation (pairing a response to its request, timing it) to the observer instead of performing it at the emit site. Named apart from the server's hook because a plugin author writing both halves of a pair would otherwise read two identically-named hooks as carrying the same union. Distinct from [[Client-local truth]], which is what a client tap exists to expose.

### Client-local truth
Resolved 2026-07-28 (ADR-0024). What a client knows that no server can be asked. super-line is server-authoritative, so nearly every question is answered by the server — but a class of them cannot be: whether a request was sent or is queued behind an unwritable socket, how long a reconnect will wait and on which attempt, which of several live subscriptions a delivered row landed in, whether an inbound payload failed the contract on arrival, how many listeners an event actually reached, and which of several concurrently-live clients a page is running (a [[Session replacement]] deliberately runs incumbent and candidate at once). None of it crosses the wire, so no observer positioned at the server can reconstruct it at any price. It is the **complement** of the server-authoritative view, not a subset — which is why an observer running in the page is not a redundant second Control Center.

### Remote interest
Resolved 2026-07-29. Whether any node *other than the publisher* holds a live listener for a channel. super-line has no such concept: an [[Transport vs Adapter]] Adapter's `subscribe(channel)` tells the **local** node what to keep, and nothing tells a publisher whether the frame is wanted anywhere else — so every publish is unconditional. Where filtering happens is consequently an Adapter-private choice with no contract behind it: Redis (`SUBSCRIBE`) and RabbitMQ (`queueBind`) filter at the broker, while the libp2p adapter puts every channel on one gossipsub topic and filters *after* delivery, so each node receives every frame the whole cluster publishes. This single gap is the origin of four distinct symptoms — deliveries discarded on arrival, publishes no node anywhere wanted, mesh hops for channels whose every interested member was local, and personal-channel sends that cross the mesh to reach a connection on the publishing node. Distinct from [[Local delivery strategy]], which decides how a node reaches its *own* subscribers and is orthogonal to whether the publish should have happened at all.

### Native root
Resolved 2026-07-29. A CRDT shared type that lives **beside** the schema-described root inside one [[Collection runtime]] document, rather than inside it — the way content whose merge granularity is finer than a field (collaborative text above all) enters a CRDT document collection. It exists because the document's root is owned end-to-end by the engine's diff-and-patch: a value parked inside that root is rewritten whole on every write, which is precisely the granularity rich text cannot accept. A native root is **synced by construction and invisible by construction** — the wire already carries whole-document updates, so it replicates and survives compaction with no transport change at all, while the plaintext snapshot materialises only the described root, so nothing downstream of the snapshot (validation, inspection, the queryable projection) ever sees it. That single asymmetry is the whole concept: replication is free, legibility is forfeit. Consequently a native root is outside the contract's described shape — it is not part of the document's inferred type — and is reached through the CRDT engine rather than through super-line's client, which stays free of any CRDT vocabulary by design. Distinct from an opaque subtree, which is *inside* the root and deliberately atomic — the opposite granularity.

### Ingress validation
Resolved 2026-07-29. The gate that makes an opaque merge delta validatable: the node a write **first arrives at** merges it onto a scratch copy, materialises plaintext, checks it against the contract, and only then commits and fans out. Its cost is inherently proportional to document size and history depth, because a CRDT has no cheap clone — so it is affordable exactly when writes are coarse (a field, a shape, a scene) and unaffordable when they are keystrokes. That is why it is a **property of a collection, declared on the contract beside the schema it enforces**, and not a global guarantee.

Skipping it was never novel — a delta relayed from another node has already passed the gate at *its* ingress node and is committed untested. What changed is that the skip became legible to the backend instead of being expressed as a validator that does nothing, so the fold can be skipped rather than performed and discarded. Turning it off leaves the [[Collection policy]] as the only remaining gate on content: authorization still decides *who* may write, and nothing then decides *what*. Distinct from schema-validation of LWW rows, which is per-row and cheap because a row carries no history.

### Readiness
Resolved 2026-07-29. The moment a **declared** interest becomes an **established** one — the gap between asking to receive something and being able to. Joining a room, subscribing the cluster bus, opening a plugin channel and starting a transport all cross a broker or a socket to take effect, so between the call and its effect there is a window in which the interest exists locally and nowhere else, and anything sent into it is lost with no error anywhere. The window is invisible in production, where nobody subscribes and publishes in the same millisecond, and unavoidable in tests, which always do. super-line answers this asymmetrically: every client-side surface that can be raced exposes a `ready` — a topic subscription, a connection's `env`, a collection subscription, a document handle — while the server-side ones announced their interest and returned, leaving a caller no way to know and nothing to await. That asymmetry is the concept's whole content, because the two halves race identically. Note what readiness is *not* a claim about: it says a channel will now be delivered, never that any **peer** has noticed — a gossip mesh may still be forming, which is why [[Remote interest]] stays a separate and unsolved question. Distinct from a delivery guarantee: readiness is about the receiver being wired up, not about whether a given frame arrives.

### Delivery verdict
Resolved 2026-07-29. The three-way classification every measured frame receives, so that measurement can indict waste without indicting deliberate design. **waste** — removable with no observable change for any client (a frame discarded on arrival, a publish no node wanted, a mesh hop whose every interested member was local, a delivery no listener consumed). **by-design** — a real cost attributable to a named decision, reported without indictment: relay replication under [[Clustering mode (relay | self)]], the permissive pre-OR-post row routing that keeps [[Collection runtime]] fan-out stateless per connection, presence gossip. **observation** — traffic that exists only because something is watching, which the inspector's cluster-wide republishing of every [[Tap (node-local observation)]] event makes a first-class category rather than a footnote. The headline the verdict serves is the **acceptance ratio**: per node, frames delivered to a local listener ÷ frames that arrived.
