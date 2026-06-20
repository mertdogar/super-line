# PLAN — `@super-line/adapter-rabbitmq`

A **broker-routed** alternative to `@super-line/adapter-redis`, for teams that already run (or
prefer) RabbitMQ. Same `Adapter` contract (`packages/core/src/adapter.ts`), same drop-in
ergonomics — but instead of Redis Pub/Sub, channels become **routing keys on a direct exchange**,
so the broker does selective per-channel routing. Library users now pick their substrate:
in-memory (default) → Redis (broker) → libp2p (P2P) → RabbitMQ (broker).

> Status: **DESIGN — reviewed, ready for implementation.** Decisions below were settled in a grilling
> session, then stress-tested by an adversarial multi-lens review (AMQP/`rabbitmq-client` correctness,
> reconnect/concurrency, contract integration, parity) — no critical/high defect survived; the
> verified accuracy/robustness fixes are folded in. Rationale is captured so we don't relitigate.

---

## 1. Goal & framing

- A real fourth clustering option, **at full parity** with the Redis adapter — including the
  `PresenceStore` (`srv.cluster.*`, `srv.isOnline`).
- Honest scope: RabbitMQ earns its place for teams that **already operate RabbitMQ** or want the
  broker to do **selective routing** (a node receives only the channels it subscribed to). For a
  greenfield single-datacenter cluster Redis remains simpler; this is an alternative, not a
  replacement.
- Priority (user-stated): **stability** and **presence must be there**. The whole design is shaped
  to make correctness a broker-enforced invariant and to survive reconnects deterministically.
- "Must implement at least the same features as the others" → **full parity**, no feature gaps.

## 2. RabbitMQ baseline (verified 2026-06; re-verify exact versions at build)

- Client: **`rabbitmq-client`** (cody-greene) — CJS-first with bundled types; built-in **automatic
  reconnection with exponential backoff** and **topology recovery** (its resilient `Consumer`/
  `Publisher` re-run all *statically declared* setup after every reconnect).
- `new Connection(url | options)` connects immediately; `connection.onConnect(timeoutMs)` awaits the
  first connect; `connection.on('connection', …)` fires on **every (re)connect** — our reconcile hook.
- A **server-named** exclusive queue gets a **new name on every reconnect**; a **fixed-name**
  exclusive queue re-declares under the same name — required so externally-issued (dynamic) binds
  re-target correctly.
- Delivery on this design is best-effort, no backfill (at-most-once) — matching the existing Redis/
  libp2p posture. Handlers are already idempotent.
- RabbitMQ has **no shared key-value store**, so the Redis-style centralized presence directory is
  impossible; presence is gossip-replicated over the same exchange (§4.4).

## 3. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| Q1 | channel → broker mapping | **Direct exchange + real per-channel bindings** (broker-side selective routing) |
| Q2 | reconnect survival | **Fixed-name exclusive auto-delete queue owned by the resilient Consumer (queue + static `sl.presence` binding auto-recover); adapter-tracked `subscribed` Set replayed by an idempotent reconcile fired off the Consumer's `ready` event (initial + every reconnect)** |
| Q3 | client library | **`rabbitmq-client`** (built-in reconnect + topology recovery; one dependency) |
| Q4 | presence directory | **Duplicate `GossipPresence` + `PresenceMsg` + its reconcile test into the package** (no cross-adapter imports; `core`/`libp2p` untouched) |
| Q5 | delivery semantics | **Ephemeral fire-and-forget** — durable direct exchange · non-persistent messages · exclusive auto-delete queue · **auto-ack on handler return + `requeue: false`** (createConsumer-native at-most-once; there is no `noAck` flag on `createConsumer`) · no publisher confirms |
| Q6a | wire encoding | **Always publish a raw `Buffer` w/ `contentType: 'application/octet-stream'`; deliver the raw `Buffer`** (mirrors Redis; binary survives; no envelope framing — `msg.routingKey` carries the channel) |
| Q6b | reserved presence key | **`sl.presence`** routing key, bound statically by every node (printable; can't collide with `r:`/`t:`/`c:`/`u:`/`reply:`/`i:`/`s2s`) |
| Q7 | factory + options | **Async `createRabbitmqAdapter(string \| options): Promise<Adapter & { connection }>`**; `url` (simple) vs BYO `connection` (advanced); `exchange` / `queuePrefix` / `presence` |
| Q8 | build target | **Dual CJS+ESM via `tsup`** (mirror `adapter-redis`; RabbitMQ shops skew Node/CJS) |
| Q9 | tests | **Mirror the Redis integration suite** (testcontainers `rabbitmq:4`, skip without Docker) **+ one reconnect-resilience test** (`container.restart()` → fan-out resumes) + duplicated presence unit test |
| Q10 | examples | **Both** `react-chat-cluster-rabbitmq` **and** `scaling-rabbitmq` |
| Q11 | delivery plan | **6 TDD slices** (reconnect resilience pulled forward to slice 2), this PLAN reviewed first |

## 4. Architecture

### 4.1 Fan-out: one direct exchange + per-channel bindings

One **durable `direct` exchange** (default `super-line`). Each node owns **one fixed-name,
exclusive, auto-delete queue** (`<queuePrefix>.<uuid>`, default prefix `sl.node`, `<uuid>` generated
once at adapter construction). A channel name is used **verbatim as the routing key**.

```
subscribe(channel)   -> assertKeyLen(channel); subscribed.add(channel)
                        await queueBind({queue, exchange, routingKey: channel})   // strict: surfaces to the subscriber
unsubscribe(channel) -> subscribed.delete(channel)
                        try { await queueUnbind({queue, exchange, routingKey: channel}) } catch {}  // best-effort
publish(channel, p)  -> assertKeyLen(channel)
                        publisher.send({exchange, routingKey: channel}, Buffer(p),
                          {contentType: 'application/octet-stream', durable: false})   // errors swallowed
on message(msg)      -> channel = msg.routingKey
                        if channel === 'sl.presence': presence.receive(JSON.parse(msg.body))
                        else if subscribed.has(channel): handler(channel, msg.body)   // Buffer
```

- **Selective routing**: the broker delivers a message only to nodes whose queue is bound to that
  routing key. A node only subscribes to channels with a local member (Redis-equivalent behaviour).
- **Loopback is natural**: the publishing node's queue is bound to any channel it has a local member
  on, so the broker routes its own publish back to it → it delivers to local members once (exactly
  Redis's model; no explicit loopback code, unlike libp2p).
- All channel types are opaque routing keys — `r:room`, `t:role:topic`, `c:connId` (targeted),
  `u:userId`, `reply:nodeId` (origin's own), `i:…`, `s2s` — the adapter treats them uniformly.
- The `subscribed: Set<string>` is the **desired-state** source of truth for §4.2.
- **Error posture (mirror Redis, do NOT blanket-swallow):** `subscribe` is **strict** — the
  `queueBind` reject propagates so the client's subscribe ack / `.ready` surfaces a real failure
  (matches `adapter-redis/src/index.ts:159`). With `rabbitmq-client`, the convenience `queueBind`
  rides a *lazy channel* that **waits for reconnect** (bounded by `acquireTimeout`, ~20s), so a
  transient blip resolves rather than rejecting; only a sustained outage rejects. `unsubscribe` is
  **best-effort** (try/catch + early-return when closed, matching `adapter-redis:161-168`) — the
  exclusive queue + the `subscribed` reconcile already make a missed unbind self-correcting.
- **Routing-key length (parity caveat, see §6):** AMQP 0.9.1 routing keys are `shortstr` (**max 255
  bytes**); Redis/libp2p/memory have no such cap. Since channel names embed user-controlled input
  (`r:`+room, `u:`+userId from `identify`, `t:`+ns+topic), `assertKeyLen` throws a clear
  `channel "<name>" exceeds RabbitMQ's 255-byte routing-key limit` rather than letting an opaque
  encoder `RangeError` surface (or a swallowed publish silently vanish). **Do not hash/truncate** —
  a per-node hash would desync routing keys across nodes and break fan-out far more subtly.

### 4.2 Reconnect survival: declare → reconcile (the core of B)

All of B's stability risk is "don't lose bindings across a reconnect." Ownership is split cleanly
between what's **static** (the Consumer recovers it declaratively) and what's **dynamic** (the
reconcile replays it):

```
// The resilient Consumer OWNS the queue + the static presence binding; it re-runs ALL of this
// after every reconnect, on its own channel:
createConsumer({
  queue, queueOptions: { exclusive: true, autoDelete: true },
  exchanges:     [{ exchange, type: 'direct', durable: true }],
  queueBindings: [{ exchange, routingKey: 'sl.presence' }],   // static — auto-recovered
  requeue: false,                                             // auto-ack on return; a throw drops (at-most-once)
}, onMessage)

// Reconcile fires off the Consumer's `ready` event (initial AND every reconnect) — `ready` fires
// AFTER the queue is re-declared, so dynamic binds always target an existing queue:
consumer.on('ready', async () => {
  for (const channel of subscribed) await queueBind({ queue, exchange, routingKey: channel })  // dynamic — replayed
  presence?.resnapshot()                                       // re-advertise our slice (see §4.4)
})
```

- The exclusive queue dies with the connection (broker-enforced), so there are **no stale bindings
  to diff away** — reconcile collapses to "bind the whole Set." Idempotent, order-independent,
  depends only on what *should* be true now (not on what happened during the outage). That property
  is why it's the stable choice.
- **Single owner per concern (no double-declare).** The Consumer alone declares the queue and binds
  `sl.presence`; the reconcile alone replays the dynamic Set. We do **not** also `queueDeclare` /
  re-bind `sl.presence` in the reconcile — that would redundantly declare the queue from a second
  channel and risk a `406 PRECONDITION_FAILED` if its options ever drifted from `queueOptions`.
  Firing off `ready` (not the raw `connection` event) removes the cross-channel ordering ambiguity.
- **Iterate the live `subscribed` Set, not a snapshot.** A frozen copy (`[...subscribed]`) would
  re-bind a channel whose `unsubscribe`/`queueUnbind` already flew during the reconnect → it would
  *manufacture* a stale binding. Live-Set iteration honours delete-before-visit, and binds are
  idempotent, so concurrent join/leave during a reconcile converges correctly (the shipped libp2p
  adapter uses this exact live-Set pattern).
- Messages arriving during the bind-replay window are missed — consistent with at-most-once (same as
  a Redis blip; the post-`subscribe` window is no wider than Redis's `SUBSCRIBE`, both one RPC).
- **Rejected alternative**: durable, non-exclusive per-node queue with TTL/length caps (blip
  durability). Wrong here — delivering stale real-time events after reconnect breaks parity, and a
  queue outliving its consumer risks unbounded broker-memory growth. Exclusive auto-delete makes
  "node gone → queue + bindings vanish" a broker invariant.

### 4.3 Wire encoding + reserved presence key

- Payloads are already-serialized wire bytes (`string | Uint8Array`, possibly binary). Publish as a
  raw `Buffer` with `contentType: 'application/octet-stream'` so `rabbitmq-client` does **not**
  JSON-/text-decode them; deliver the raw `Buffer` (a `Buffer` *is* a `Uint8Array`, which the
  server's `onMessage` already accepts). Mirrors the Redis adapter (always-`Buffer` delivery).
- No envelope framing (libp2p needed it because a gossipsub topic carries no per-message key);
  `msg.routingKey` already carries the channel.
- Presence rides the same exchange under the reserved routing key **`sl.presence`**, bound by every
  node **statically** (in the Consumer's declared `queueBindings`) so it survives reconnects without
  replay. Its payload is a JSON `PresenceMsg`. A node ignores echoes of its own `nodeId`.

### 4.4 Presence: duplicated gossip-replicated directory

`GossipPresence` (+ the `PresenceMsg` type + its reconcile unit test) is **copied verbatim** from
`packages/adapter-libp2p/src/presence.ts` into `packages/adapter-rabbitmq/src/presence.ts`. It is
transport-agnostic — a `broadcast(msg)` callback + a `receive(msg)` method. No cross-adapter import;
`core` and the shipped libp2p adapter are untouched. The two `PresenceMsg` wire formats never
interoperate (a cluster runs a single adapter type), so divergence is a maintenance note, not a
correctness risk.

Wiring in the RabbitMQ adapter:
```
const presence = new GossipPresence(
  (msg) => publish('sl.presence', JSON.stringify(msg)),   // broadcast
  typeof opts.presence === 'object' ? opts.presence : {},
)
// in onMessage: if routingKey === 'sl.presence' → presence.receive(JSON.parse(body))
```

- Single-writer-per-slice; deltas on change + periodic snapshot (anti-entropy); monotonic per-node
  `seq` guards reconcile; reads are local map scans.
- **Liveness** is snapshot-refresh TTL. The verbatim-copied class hard-defaults to
  `snapshotIntervalMs = 10_000`, `livenessTtlMs = 30_000` (a peer refreshes a node's `lastSeen` on
  every delta/snapshot it receives; 10s snapshot ≪ 30s TTL gives 3 missed-snapshot slack, and a
  node's own slice is exempt from the cutoff, so there is no flicker even though the server's default
  heartbeat is also 30s). A *crashed* node's connections clear after ~30s — i.e. **faster** crash
  detection than Redis's ~90s key TTL, just eventually-consistent. Rejected: deriving liveness from
  the broker auto-deleting a dead node's queue (extra broker-event machinery, not worth it).
- **Re-advertise on reconnect.** `beat()` only updates the *local* self `lastSeen` and never
  broadcasts, so after an outage longer than `livenessTtlMs` a reconnected node would be invisible to
  peers that already evicted it until its next snapshot timer. The reconcile (§4.2) therefore calls
  `presence.resnapshot()` — a thin public method added to the copied class that invokes the existing
  private `sendSnapshot()` — re-advertising the slice immediately. (The libp2p copy carries the same
  latent gap; out of scope to fix there, noted so the two copies don't silently diverge.)
- `presence: false` disables presence; `srv.cluster.*` then throws the existing clear error.

### 4.5 Factory, options, lifecycle

```ts
export interface RabbitmqAdapterOptions {
  url?: string             // 'amqp://user:pass@host:5672' — the simple case
  connection?: Connection  // BYO already-constructed rabbitmq-client Connection — advanced (TLS / multi-host / vhost / heartbeat)
  exchange?: string        // default 'super-line'
  queuePrefix?: string     // default 'sl.node' → queue 'sl.node.<uuid>'
  presence?: false | { snapshotIntervalMs?: number; livenessTtlMs?: number }
}
export function createRabbitmqAdapter(
  options?: RabbitmqAdapterOptions | string,
): Promise<Adapter & { connection: Connection }>   // async
```

- **Async factory** returns a *ready* adapter: `await connection.onConnect()` → declare exchange →
  create resilient Consumer + Publisher → wait `ready`. Required because the server calls
  `subscribe(replyChannel)` immediately on construction.
- **`string | options` overload** mirrors `createRedisAdapter('redis://…')`; a bare `'amqp://…'` is
  the 90% case.
- **`url` vs BYO `connection`** mirrors libp2p's "built-in node vs bring-your-own." Advanced needs
  (TLS, multi-host failover, custom heartbeat, vhost) → construct `new Connection({…})` and pass it;
  the adapter then **does not own its lifecycle** — `close()` leaves a BYO connection open.
- **`.connection`** is exposed on the returned adapter (like libp2p's `.node`) for debugging /
  management.
- **Error posture**: swallow transient publish errors and `connection`-level errors (match the Redis
  adapter — `pub.on('error', () => {})`); nothing is thrown into the process for a blip. Optionally
  log `connection.blocked`/`unblocked` (broker resource pressure) as a warning. (Subscribe/unsubscribe
  error posture is in §4.1 — strict subscribe, best-effort unsubscribe — not blanket-swallowed.)
- **INVARIANT — single-connection exclusivity.** An exclusive queue is owned by the *connection* that
  declares it (per-connection, not per-channel); a *second* connection touching it gets
  `405 RESOURCE_LOCKED`. So the resilient Consumer and **every** raw `queueBind`/`queueUnbind`
  (subscribe/unsubscribe and the reconcile) MUST run on the **one** adapter-owned (or single BYO)
  `Connection`. Never create a second `Connection` for these — note this is *unlike* the Redis
  adapter, which deliberately uses two connections. The Publisher is **exempt**: it only `send`s to
  the exchange and never touches the queue, so queue exclusivity doesn't constrain it (we keep it on
  the same connection purely for simplicity).
- **Lifecycle**: `close()` first flushes the node's own presence **leave** (`publisher.send`'s the
  `{t:'l'}` `PresenceMsg` on `sl.presence` so it reaches the broker *before* teardown), then stops
  the Consumer, the presence timer, and — only for an adapter-owned connection — closes the
  `Connection`. Note: `clearNode(instanceId)` synchronously removes the node's *own* replica, but the
  leave broadcast is fire-and-forget; the explicit pre-teardown flush is what makes remote eviction
  prompt. Absent the flush, remote nodes fall back to `livenessTtlMs` eviction (~30s) — same latent
  behaviour as the shipped libp2p adapter, and looser than Redis (whose `clearNode` awaits real
  broker round-trips and is authoritative).

### 4.6 Deployment notes (docs)

- The durable exchange survives a broker restart; exclusive queues + dynamic bindings do not — the
  adapter re-establishes them on reconnect (§4.2). Nothing accumulates while a node is down.
- For broker HA, pass a BYO `Connection` with a `hosts: [...]` list (round-robin failover) and TLS.
- Management UI (`rabbitmq:4-management`, port 15672) is recommended for the **examples** so users
  can watch exchanges/queues/bindings; the **tests** use plain `rabbitmq:4` (AMQP only).

## 5. TDD slices (red → green)

1. **Fan-out skeleton + topology.** Async `createRabbitmqAdapter` (onConnect → durable direct
   exchange → fixed-name exclusive auto-delete queue owned by the resilient Consumer + Publisher);
   `subscribe` (strict) / `unsubscribe` (best-effort) (Set + `queueBind`/`queueUnbind`); `publish`
   (Buffer/octet-stream, fire-and-forget); `onMessage` (routingKey→channel, Set filter); natural
   broker loopback; `assertKeyLen`; `close()`. → `rabbitmq-cross-node` (room + topic fan-out across
   two server processes / one broker) + a guard test: a >255-byte channel name throws a clear error
   on this adapter (and a note that it succeeds on Redis — the documented parity gap).
2. **Reconnect resilience (B's core).** Reconcile fired off the Consumer's `ready` event: replay the
   `subscribed` Set + `resnapshot()`. → `rabbitmq-reconnect` (`container.restart()` drops connections
   + queues + dynamic bindings; durable exchange survives; assert a **dynamic** `r:room` binding —
   not just the static presence path — resumes fan-out after auto-reconnect, so the dynamic-Set
   replay is actually exercised).
3. **Targeted + bus.** `c:`/`u:` targeted emit + `reply:` round-trip; `server.publish`/`subscribe`
   cluster event bus with local echo (uniform channel handling — verify). → `rabbitmq-targeted`,
   `bus.rabbitmq`.
4. **Presence directory.** Duplicate `GossipPresence` + `PresenceMsg` + reconcile unit test into the
   package; wire `broadcast`→`publish('sl.presence')` / receive; static presence binding; `clearNode`
   on shutdown. → `presence.reconcile` (unit) + `rabbitmq-presence` (`cluster.*` / `isOnline` /
   `topology` / liveness / `presence:false` throws).
5. **Inspector + packaging.** `msg.*` inspector events cluster-wide (verify free); finalize options
   (exchange / queuePrefix / presence timings / BYO connection / `.connection`); swallow transient
   errors. **Copy `adapter-redis`'s `package.json` + `tsup.config.ts` verbatim (NOT `adapter-libp2p`,
   which is ESM-only):** `tsup` `format: ['esm','cjs']`; `package.json` `main: ./dist/index.cjs`,
   `module: ./dist/index.js`, `types`, and `exports['.']` carrying **both** an `import` branch and a
   `require` branch (`require.types: ./dist/index.d.cts`, `require.default: ./dist/index.cjs`);
   verify post-build that `dist/index.cjs` and `dist/index.d.cts` exist. → `rabbitmq-inspector`.
6. **Examples + docs.** `react-chat-cluster-rabbitmq` (clone of `react-chat-cluster-libp2p`, swap
   adapter + `docker-compose` to a `rabbitmq:4-management` service + N nodes) **and**
   `scaling-rabbitmq` (clone of `examples/scaling`); package README + typedoc reference mirroring
   `adapter-redis`; update the scaling-adapters guide to list RabbitMQ as a fourth alternative —
   and document the presence semantics: crashed-node connections clear after ~`livenessTtlMs`
   (default ~30s, faster than Redis's ~90s, tunable), graceful shutdown clears promptly via the
   leave flush, and presence is eventually-consistent.

## 6. Open risks / accepted trade-offs

- **Dynamic-binding reconnect window**: messages published while a node is re-binding after a
  reconnect are lost (at-most-once; bounded by reconnect + reconcile latency). Verified by slice 2.
- **Bind/unbind churn**: frequent room joins/leaves = frequent `queueBind`/`queueUnbind` RPCs. Cheap
  on RabbitMQ at target scale; if it ever bites, batch/debounce unbinds (no contract change).
- **Replica memory** is O(total connections) per node (gossip directory). Documented; fine at target
  scale. Secondary indexes are the same deferred optimization as libp2p.
- **Optimistic deltas** can show brief presence drift until the next snapshot (bounded by
  `snapshotIntervalMs`).
- **`rabbitmq-client` is a single-maintainer dependency**: pin the version; re-read the changelog on
  upgrade. Fallback path is `amqplib` + `amqp-connection-manager` if it were ever abandoned.
- **Per-node fixed queue name collision**: `<uuid>` makes this effectively impossible; documented.
- **Routing-key 255-byte limit (parity gap vs Redis/libp2p/memory)**: a channel name (embedding
  user-controlled room/userId/topic) longer than 255 bytes is rejected by `assertKeyLen` with a clear
  error. Accepted: pathological names are not a real workload, and an honest error beats a silent
  hash-desync. Documented in §4.1 / README.
- **Implementation guardrails (don't "fix" these — they're correct):** iterate the live `subscribed`
  Set in the reconcile, never a `[...subscribed]` snapshot (a snapshot manufactures stale bindings);
  never open a second `Connection` for queue ops (breaks exclusivity, §4.5 invariant).

## 7. Dependencies (pin at build; versions current ~2026-06)

`rabbitmq-client`. `@super-line/core` as `workspace:^`. Build mirrors `adapter-redis` (tsup ESM+CJS,
externalized deps). Test additions to `@super-line/server` devDependencies: `@super-line/adapter-rabbitmq`
(`workspace:*`) + `rabbitmq-client` (`testcontainers` already present).
