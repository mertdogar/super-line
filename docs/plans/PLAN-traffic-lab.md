# PLAN — Traffic lab: measuring and eliminating unnecessary fan-out

Build a permanent, private workspace package (`packages/traffic-lab`) that stands up a real
multi-container super-line cluster, taps **every** plane the bytes cross — logical, adapter,
gossipsub mesh, and client wire — and produces a classified traffic report plus a committed
baseline. Then use it to land the two fan-out fixes that code reading already justifies, with
before/after numbers as the proof.

Designed 2026-07-29 in a `/grilling` session after reading the fan-out paths end to end. The
driving question: **where does super-line send bytes nobody wanted?** Code reading found seven
suspects and one structural cause; none of them has a number attached, which is what this lab is
for.

## Status

**BUILT — phases 0–7 complete, 2026-07-29, on branch `traffic-lab` (local, not pushed).**

- **Phases 0–5 (the lab).** `packages/traffic-lab`, four tap layers, eleven phases, the analyzer,
  the committed baseline, and the `{libp2p, redis} × {inspector off, on}` matrix behind
  `node run.mjs`. mDNS verified across a plain Docker bridge — no `network_mode: host`, no
  bootstrap list.
- **Phase 6 (F1) and Phase 7 (F2) landed**, both with regression tests verified to fail without
  the fix. Both lanes green (fast 796, integration 159 — one pglite compaction test flakes under
  container CPU contention and passes standalone; pre-existing, see CLAUDE.md).

### What the matrix measured

Identical workload throughout — `delivers` is 1850 in all four profiles both before and after, so
every difference below is overhead, not workload.

| | publishes | mesh arrivals | acceptance |
|---|---:|---:|---:|
| libp2p, inspector off — before | 850 | 2560 | 80.5% |
| libp2p, inspector **on** — before | 4893 | 10636 | **19.3%** |
| all four profiles — after F1+F2 | **750** | **2360** | **87.3%** |

- **F1**: with no Control Center attached anywhere, the inspector was 75.9% of all cross-node
  traffic (2.28 MB of ~3.1 MB), every frame discarded. An inspector-enabled node is now
  byte-identical to one without the plugin.
- **F2**: `emit-local` went from 100 publishes and 200 discarded arrivals to **zero of both** — the
  phase no longer touches the wire at all.
- **Residual waste is 12.7%, and all of it is F3**: 200 discarded from `room-local` and 100 from
  `emit-remote`'s third node. Nothing else in the workload wastes a frame, which is a sharper
  statement of the open problem than the plan started with.

### Findings the lab produced that were not on the suspect list

- **A client whose first dial was refused never reconnected.** `webSocketClientTransport` wired
  `onclose` but not `onerror`, and Node 22's undici fires ONLY `error` for a failed handshake. Every
  lab client failed to connect on a cold start. Invisible on a Node 24 dev machine, fatal in the
  `node:22` containers this repo ships. Fixed with a regression test that scripts both event
  sequences rather than dialling a dead port.
- **Presence gossip is the largest single by-design category** — 859 arrivals / 129 KB, larger than
  every application pattern combined, and it scales with room churn rather than with traffic. F5 now
  has a number.
- **Measured overhead is 18–22×**: total interface bytes over bytes super-line can account for.
  gossipsub's control traffic dwarfs the payloads it carries — which is the strongest argument yet
  against F3a (a topic per channel), since that overhead scales with topic count.
- **A CRDT create is node-local and does not relay**, so a node that never ran one answers `open`
  with `NOT_FOUND` forever. The lab has to seed every node. Sharp edge, not addressed here.
- **Interest is state, not an event.** F1's first cut announced once on the edge; the cross-process
  inspector tests converged at exactly 10.04s, proving the announcement had been lost outright and
  the keepalive was the only recovery. Re-assertion period is now 2s.

### Still open

- **Open decision 1 is unresolved** and was taken the conservative way: the mesh tap duplicates the
  libp2p channel codec rather than adding public API to a published package unattended. Swapping to
  an export is a two-line change.
- **`transport-websocket`, `server` and `plugin-inspector` all have source changes and no version
  bump.** Per CLAUDE.md that is a release, not an option — but a release tag must be pushed with the
  release, so none was created.

## What the code reading established

Seven suspects, with evidence. These are the hypotheses the lab exists to confirm or kill — none
is a measured fact yet.

| # | Finding | Evidence |
|---|---|---|
| 1 | **The libp2p adapter puts every channel on ONE gossipsub topic.** `subscribe(ch)` is `subscribed.add(ch)` — a local `Set`. Every node receives every frame the whole cluster publishes and discards the uninteresting ones *after* delivery and decode. Redis (`SUBSCRIBE`) and RabbitMQ (`queueBind`) filter at the broker; libp2p filters after the fact. | `adapter-libp2p/src/index.ts:327,336-343,309-325` |
| 2 | **The inspector republishes every tapped event cluster-wide whether or not any Control Center exists**, and the envelope carries a redacted snapshot of the payload — so it is comparable in size to the message it describes. Both libp2p examples enable it. | `plugin-inspector/src/index.ts:291-301` |
| 3 | **`srv.toConn(id).emit()` always crosses the mesh, even when the connection is local.** No locality check. Same for `.close()`, `.setEnv()`, and `requestConn`, which additionally waits for the reply to come back over `reply:<nodeId>`. | `server/src/index.ts:1516-1524,1417-1441,1443-1476` |
| 4 | **Rooms and topics are deliver-on-receipt, so the publish is unconditional.** Correct as documented — but combined with (1) a room whose every member is on the publishing node still costs a full mesh broadcast. | `core/src/adapter.ts:1-9`, `server/src/index.ts:1306-1327` |
| 5 | **One global `COLL_CHANNEL` (`'cbatch'`) carries every row collection.** No per-collection granularity; a node that will never serve collection X still receives, decodes and applies every X write. | `server/src/index.ts:1304`, `collections/rows.ts:30,224,311-324` |
| 6 | **Presence gossip is unconditional and periodic** — a full `ConnDescriptor[]` snapshot per node every 10s, plus a delta on every conn set/del and *every room join/leave*. Scales with connections × churn, independent of app traffic. | `adapter-libp2p/src/presence.ts:46,51-77,183-188` |
| 7 | **There is no observability at the adapter layer at all.** `InspectorEvent` is a purely logical taxonomy — `msg.broadcast` is one event for N recipients, and nothing in the union can express "this node received a frame it discarded". The layer to be optimised is the one with no tap. | `core/src/inspector.ts:118-153` |

**The unifying cause is [[Remote interest]]** (CONTEXT.md): an `Adapter`'s `subscribe(channel)` tells
the **local** node what to keep, and nothing tells a publisher whether the frame is wanted anywhere
else. Suspects 1–4 are all that one hole.

### Facts that shape the rig

- **Every seam the lab needs is already public and decoratable.** `Adapter` (6 methods),
  `ServerTransport`/`ClientTransport`/`RawConn` (`core/src/transport.ts`), the server plugin
  `onEvent` tap, and the client plugin `onClientSideEvent` tap (`client/src/index.ts:330-349,392`).
  The libp2p adapter also returns its node (`adapter.node`), which is what makes the mesh layer
  reachable.
- **The lab's own instrumentation adds zero frames.** Every tap writes NDJSON to disk. This is the
  opposite of the inspector, which republishes what it observes over the very bus being measured —
  and is precisely why the lab can measure the inspector.
- **Reserved connections are observer-invisible: no lifecycle hooks fire for them**
  (`server/src/index.ts:1077-1090`), and `connection.handlers` is invoked **once at setup**, not per
  connection (`server/src/index.ts:1679-1684`). So a plugin cannot see its own Control Center
  connect or disconnect today. This is what forces the small core addition in F1.
- **Connection ids are `randomUUID()`** (host-overridable via `authenticate`)
  (`server/src/index.ts:1054`), so only the owning node ever subscribes `c:<id>` — which is what
  makes F2's local short-circuit provably safe.
- **Channel prefixes**: `r:<room>` · `t:<ns>:<topic>` · `c:<connId>` · `u:<userId>` ·
  `reply:<nodeId>` · `x:<plugin>:<name>` · `d:<collection>:<docId>` · `cbatch` (all row
  collections) · `\x00sl:presence` (libp2p-internal — never reaches the `Adapter` interface, so
  **only the mesh layer can see presence gossip**).
- **`packages/*` needs zero tooling edits.** The workspace glob, `lint`, and root `typecheck`
  already cover it, and `scripts/check-manifest.mjs` skips any package without a `tsup.config.ts`
  (line 77). `packages/devtools-extension` is the precedent for a private, never-published package
  there.

## The decision tree (dependency order)

| # | Fork | Decision |
|---|------|----------|
| 1 | Lifetime | **Permanent fixture in the repo**, not a throwaway. It must survive package churn and earn its upkeep, which is what forces decisions 2 and 8. |
| 2 | Output | **Report + committed baseline diff.** Each run writes `report.md` and diffs against `baseline.json`, so "this refactor tripled cross-node frames" shows up in review. **Manual `pnpm traffic-lab`, not a CI gate** — Docker plus gossipsub timing is too noisy to block merges on. |
| 3 | Tap depth | **Four in-process layers plus NIC counters.** L1 server `onEvent` · L2 `Adapter` decorator · L3 raw gossipsub listener · L5 client `onClientSideEvent`; plus `/sys/class/net/eth0/statistics/{rx,tx}_bytes` per container for attributed-vs-total overhead. No privileges, full attribution. Server-side per-connection egress (a `ServerTransport` wrapper) and a pcap sidecar were both considered and **deferred** — the client tap already answers the server→client waste question, and pcap needs privileged containers. |
| 4 | Workload | **Phased traffic zoo, all patterns**, with quiet gaps between phases. Includes an **idle baseline** phase (what a 3-node cluster costs with zero app traffic) and a **locality contrast** (all-local room vs spread room), which is the experiment that isolates the cost of missing [[Remote interest]]. |
| 5 | Client placement | **Pinned, no load balancer.** A round-robin Caddy would destroy the locality contrast. 2 clients on node-1, 1 on node-2, 1 on node-3. |
| 6 | Orchestration | **Conductor container over HTTP.** Gates on readiness, drives phase transitions, runs the analyzer. The control plane is HTTP, provably outside both the super-line wire and the libp2p mesh, so nothing it does lands in the numbers. |
| 7 | Inspector | **Two profiles per run, diffed** (`off`, then `on`). Clean numbers for every other finding, and the diff *is* suspect #2 quantified. |
| 8 | Adapter scope | **libp2p + a Redis control.** Same workload, same phases, two adapters. Without a reference point "62% of arriving frames discarded" is a number nobody can calibrate. |
| 9 | Verdict axis | **Three-tier [[Delivery verdict]]** — `waste` · `by-design` · `observation`. Lets the report indict waste without indicting deliberate design (relay replication, permissive row routing, presence gossip). |
| 10 | Placement | **`packages/traffic-lab`, private, `version: 0.0.0`, `workspace:*` deps, no `tsup.config.ts`.** Zero tooling edits; `devtools-extension` is the precedent. |
| 11 | Scope of fixes | **Lab + F1 + F2 with before/after.** F3/F4/F5 become a ranked, evidence-backed follow-up with its own design session. **No `Adapter` interface change in this effort.** |

### Why the 2×2 is the interesting table

Reading the code, the inspector's cost is expected to be **adapter-dependent**: on Redis its
unconditional publish lands on a channel with zero subscribers and is nearly free; on libp2p the
identical call is a full mesh broadcast to every node. If that holds, suspect #2 is mostly a libp2p
story and F1's value should be quoted per-adapter. `{libp2p, redis} × {inspector off, on}` = four
runs.

## Open decisions (need sign-off before Phase 1)

1. **Export the libp2p channel codec.** L3 must decode the adapter's private
   `[u16 channelLen][channel][u8 kind][payload]` framing (`adapter-libp2p/src/index.ts:110-128`).
   **Recommendation: export `frameChannel`/`unframeChannel` from `@super-line/adapter-libp2p`**
   (two lines) rather than duplicate the codec in the lab, where it would silently mis-attribute if
   the framing ever changed. This is a public API addition to a published package. The alternative
   is duplication plus a loud assertion on decode — smaller blast radius, real rot risk given
   decision 1.
2. **Dumps ride a shared Docker volume, not an HTTP endpoint.** A simplification of the agreed
   orchestration: containers need no `/dump` route, and HTTP carries only readiness and phase
   control. Same isolation guarantee, less code.

## Architecture

### Containers

| Service | Count | Role |
|---|---|---|
| `node-1` `node-2` `node-3` | 3 | super-line servers, same image. libp2p adapter with `discovery: 'mdns'`, or Redis under the control profile. Each exposes `GET /ready` (peer count + adapter state). |
| `client-1a` `client-1b` | 2 | pinned to `node-1` — together they form the **all-local room** |
| `client-2` `client-3` | 2 | pinned to `node-2` / `node-3` — with `client-1a` they form the **spread room** |
| `conductor` | 1 | readiness gate, phase driver, analyzer |
| `redis` | 0–1 | control profile only |

All dumps land on a shared named volume the conductor reads directly.

### Package layout

```
packages/traffic-lab/
  package.json          # private, 0.0.0, workspace:* deps, no tsup.config.ts
  README.md             # how to run, how to read the report, how to update the baseline
  docker-compose.yml    # profiles: libp2p | redis, × SL_INSPECTOR=off|on
  Dockerfile            # node:22-slim + corepack + pnpm install (scaling-libp2p's pattern)
  baseline.json         # COMMITTED — the diff target
  src/
    contract.ts         # the traffic-zoo contract (all wire patterns)
    phases.ts           # the phase table, shared by conductor and clients
    node.ts             # server entrypoint (all three nodes)
    client.ts           # workload client entrypoint
    conductor.ts        # orchestrator
    tap/
      record.ts         # NDJSON writer + the LabRecord type
      interest.ts       # the InterestMirror (see below)
      server-tap.ts     # L1 — SuperLinePlugin { onEvent }
      adapter-tap.ts    # L2 — Adapter decorator
      mesh-tap.ts       # L3 — raw gossipsub listener
      client-tap.ts     # L5 — SuperLineClientPlugin { onClientSideEvent }
      nic.ts            # /sys/class/net counters
    analyze/
      index.ts          # dumps → report.md + baseline diff
      correlate.ts      # the op-id join
      verdict.ts        # the Delivery verdict classifier
      report.ts         # markdown rendering
```

### The InterestMirror — how "discarded" becomes computable

L3 sees every frame that arrived on the shared gossipsub topic, but the adapter's `subscribed` set
is private, so the mesh tap cannot on its own tell an accepted frame from a discarded one.

The L2 decorator intercepts `subscribe`/`unsubscribe`, so it **already knows exactly what the server
asked for**. It owns an `InterestMirror`, and L3 consults it. `accepted` becomes an in-process fact
with no access to adapter internals.

### Op-id correlation — the join that makes the report trustworthy

Every workload payload carries `{ op: <run-unique monotonic id>, phase: <n> }`. The lab owns the
contract, so L2 and L3 can decode a frame far enough to read the op id. One op id then threads
through every layer:

```
L1 (what the app asked for) → L2 (what was published, from which node)
   → L3 (which nodes it arrived at, and which of them accepted it)
      → L5 (which clients received it, and what they did with it)
```

Frames with no op id — presence, heartbeats, inspector envelopes, reply frames — get `op: null` and
are classified by channel alone. Additionally, gossipsub signed messages carry `from` +
`sequenceNumber`, giving an exact cross-node message identity for the L3 side of the join
independent of payload decoding.

### Record shape

```ts
type LabRecord = {
  t: number                     // epoch ms
  actor: string                 // 'node-1' | 'client-1a' | …
  layer: 'l1' | 'l2' | 'l3' | 'l5' | 'nic'
  phase: number | null
  op: number | null             // the workload op id, when the frame carries one
} & LayerFields
```

| Layer | Fields |
|---|---|
| L1 | `event: InspectorEvent` (live ref, snapshotted at write) |
| L2 | `op: 'publish' \| 'deliver' \| 'subscribe' \| 'unsubscribe'`, `channel`, `bytes` |
| L3 | `channel`, `bytes`, `from` (peer id), `msgId`, `accepted: boolean` |
| L5 | `event: ClientTapEvent` |
| NIC | `rx`, `tx` (cumulative; sampled at phase boundaries) |

### Workload phases

Roughly 200 ops per phase at ~20/s, with a quiet gap between each. ≈3 min per profile, ≈15 min for
all four runs.

| # | Phase | What it isolates |
|---|---|---|
| 0 | **idle baseline** — zero app traffic, 30s | presence gossip + gossipsub heartbeat alone: the fixed tax of a 3-node cluster |
| 1 | request / response | the baseline unicast path; should produce **no** cross-node traffic at all |
| 2 | `conn.emit` to a **local** vs a **remote** conn | suspect #3 — the local case should cost zero mesh frames and today costs a full broadcast |
| 3 | room broadcast: **all-on-node-1** room vs **spread** room | suspects #1 + #4 — the locality contrast, the core experiment |
| 4 | topic publish | topic fan-out, `t:` channels |
| 5 | cluster bus (`srv.publish` / `srv.subscribe`) | deliver-at-source path, for contrast with rooms |
| 6 | collection write + subscribe | suspect #5 — `cbatch` replication, and permissive row routing at the client |
| 7 | CRDT doc edit | per-doc `d:` channels under a single-topic mesh |
| 8 | room join / leave churn | suspect #6 — presence deltas per membership change |

Backends: `collections-memory` and `collections-crdt-memory` (both `relay`, no extra containers).
Auth stays trivial (`authenticate: () => ({ role: 'user', ctx: {} })`) — plugin-auth is not what is
being measured.

### The verdict classifier

| Observation | Verdict | Kind |
|---|---|---|
| L3 arrival with `accepted: false` | **waste** | discarded-on-arrival |
| a publish no node anywhere accepted (op-id join) | **waste** | cluster-zero-interest |
| a publish where only the publishing node accepted | **waste** | locally-satisfiable |
| L5 `deliver` with `listeners: 0`, `doc` with `replicas: 0` | **waste** | no-consumer |
| accepted arrival on `cbatch` | **by-design** | relay replication ([[Clustering mode]]) |
| L5 `route: left-filter \| skip` | **by-design** | permissive row routing (stateless per-conn fan-out) |
| `\x00sl:presence` traffic (mesh layer only) | **by-design** | presence gossip |
| any channel prefixed `x:inspector:` | **observation** | — |

Headline metric: **acceptance ratio** = frames delivered to a local listener ÷ frames that arrived,
per node.

**Asymmetry to state honestly in the report:** the Redis profile has no L3 — there is no mesh to
listen to, and Redis filters at the broker, so its acceptance ratio is 1.0 by construction. Its role
is to supply the *bytes* and *publish-count* reference, not an acceptance ratio. For Redis,
cross-node ground truth is the union of L2 `deliver` records across the three nodes.

### Report

`report.md`, sections in order: run header (profile, adapter, inspector, durations, image digest) ·
headline table per profile · per-phase · per-channel-prefix · verdict breakdown with top offenders ·
client-side (frames in/out per client, left-filter rate, 0-listener count) · attributed-vs-NIC
overhead factor · baseline diff.

`baseline.json` is a flat `metric-key → number` map so diffs are reviewable line-by-line in git.

## Phase 0 — Skeleton and smoke

Package, Dockerfile, compose, three nodes plus one client, mDNS discovery, conductor readiness gate.
No measurement.

**Acceptance:** `pnpm traffic-lab` brings three nodes up; each reports 2 peers on `GET /ready`; one
client connects and completes a request; conductor exits 0.

## Phase 1 — Taps and dump

The four tap modules, the NDJSON writer, the `InterestMirror`, NIC sampling. Resolves open decision
1 (codec export vs duplication).

**Acceptance:** a run produces seven non-empty NDJSON files; every L3 record carries `accepted` and
`msgId`; L2 `subscribe` records reconcile against the channels the server is known to join
(`c:<connId>` per conn, `r:` per room, `reply:<nodeId>`, `cbatch`).

## Phase 2 — Contract, phased workload, conductor

The traffic-zoo contract, `phases.ts`, op-id stamping, HTTP phase control, quiet gaps.

**Acceptance:** every record carries a phase; every app frame carries an op id; records during quiet
gaps are background-only (presence, heartbeat) — which doubles as the phase-boundary sanity check.

## Phase 3 — Analyzer, report, baseline

Op-id join, verdict classifier, `report.md`, `baseline.json`.

**Acceptance:** verdict totals sum to 100% of observed frames; a **hand-checked** phase-3 sample
shows the predicted shape — one all-local-room broadcast produces exactly two discarded arrivals
(node-2, node-3) and zero accepted remote arrivals. If it does not, the rig is wrong, not the
hypothesis.

## Phase 4 — Redis control profile

Compose profile, adapter switch by env, the L3-absence handling in the analyzer.

**Acceptance:** the identical workload runs on Redis; the report renders both profiles side by side;
Redis shows ~zero discarded-on-arrival.

## Phase 5 — Inspector profiles and the 2×2

**Acceptance:** four runs; the 2×2 table renders; the inspector's cost is quoted separately per
adapter. This phase's output is the evidence base for F1.

## Phase 6 — F1: gate the inspector on whether anyone is watching

**Core addition (small, general):** `PluginChannel` gains `readonly subscribers: number` — the local
subscriber count the server already maintains in `pluginChannels`
(`server/src/index.ts:1387-1414`). This is the minimal seam; it is needed because reserved
connections fire no lifecycle hooks, so the inspector has no other way to know a Control Center is
attached.

**Plugin change (`plugin-inspector`):**
- Local watchers = `eventsChannel.subscribers`.
- A second plugin channel `x:inspector:watchers` carries a `watch` announcement when a node's local
  count crosses 0→1, and `unwatch` on 1→0.
- Each node holds a TTL'd set of watching node ids; a watching node **re-announces every 15s**
  (receiver expiry 45s). Zero traffic when nothing is watched — which is the common case.
- `onEvent` early-returns when local watchers are 0 **and** the remote set is empty.

The re-announce is deliberate, not decoration: without it, a node that boots while a Control Center
is already connected elsewhere would silently never report — the "silently deaf" failure class, and
exactly the kind of bug that is invisible until someone notices a node missing from the feed.
At-most-once delivery rules out a one-shot `hello`/reply handshake.

Honest cost: **~40 lines across the plugin plus a 2-line core addition** — not the ~20 lines quoted
before the reserved-connection lifecycle was checked.

Rejected alternative: `inspector({ cluster: false })`, making the feed node-local. It deletes the
problem entirely and costs nothing, but degrades the product — a cluster-wide view is the Control
Center's whole point.

**Acceptance:** with no Control Center attached, `x:inspector:*` traffic is zero in the dump.
With one attached, the feed is complete on every node (verified by op-id join: every op emitted on
node-2 and node-3 reaches the Control Center on node-1). Existing plugin-inspector tests stay green.

## Phase 7 — F2: short-circuit local personal-channel sends

Two short-circuits in `server/src/index.ts`:

- `personalTarget(CONN + id)` — when `members.has(CONN + id)`, deliver through `handlePersonal`
  directly and skip `adapter.publish`. Provably safe: a conn id is a UUID and only its owning node
  ever subscribes `c:<id>`.
- `handleClientReply` — when `r.origin === instanceId`, settle the waiter directly instead of
  publishing to our own `reply:` channel.

**Not `toUser`.** `u:<userId>` can legitimately have members on several nodes, and presence is not a
reliable enough oracle to gate on.

**Behaviour change to pin with a test:** the loopback is already synchronous for the memory and
libp2p adapters (`adapter-libp2p/src/index.ts:292`), but asynchronous for Redis. The short-circuit
makes local delivery synchronous everywhere — strictly lower latency and more intuitive ordering,
but it can reorder a `toConn(x).emit(a)` against a following `conn.send(b)` on Redis relative to
today. Assert the new ordering rather than leave it incidental.

**Known pre-existing pathology, not a blocker:** a host that supplies colliding `connectionId`s
across nodes already double-delivers today; with the short-circuit it would deliver locally only.
Note it; do not design around it.

**Acceptance:** phase-2 local `conn.emit` produces **zero** cross-node frames (today: one full mesh
broadcast each). Both test lanes green. `baseline.json` diff is the proof, committed alongside.

## Invariants that must survive

- **The lab never adds a frame to what it measures.** Every tap writes to disk. Any future
  temptation to ship tap data over the bus makes the lab the thing the inspector already is.
- **The control plane stays off the measured plane.** Conductor traffic is HTTP; dumps ride a
  volume.
- **`Adapter` does not change in this effort.** Decision 11. Any fix that needs [[Remote interest]]
  as a first-class concept belongs to the follow-up.
- **Verdicts are attributed, never inferred.** A frame is `by-design` only when it maps to a named,
  citable decision. Anything unattributed is `waste` and must be explained or reclassified.
- **The baseline is committed and reviewed.** A run that moves it silently is the failure mode this
  whole fixture exists to prevent.

## Out of scope (follow-up, evidence-backed)

- **F3 — the libp2p single-topic question (suspect #1).** Deliberately unresolved: per-channel
  topics give real mesh filtering but gossipsub heartbeat and GRAFT/PRUNE churn scale with topic
  count, which is fatal for dynamic rooms; topics-by-channel-*class* is bounded and safe but coarse;
  remote-interest gossip is the real fix and carries a genuine correctness risk (a just-subscribed
  node missing frames under at-most-once delivery). **This needs the data to choose**, and probably
  an ADR.
- **F4 — `COLL_CHANNEL` granularity (suspect #5).** Likely no fix: under `relay` every node wants
  every write. Expect the report to classify it `by-design`; if it does not, that is a finding.
- **F5 — presence tuning (suspect #6).** Small and low-risk, but it should be sized against phase 0's
  measured idle cost rather than guessed at.
- **F7 — `adapter.*` in the tap vocabulary (suspect #7).** Making the lab's L2/L3 a library feature
  and surfacing cluster waste in the Control Center. Deliberately deferred: designing that
  vocabulary before knowing what the waste looks like would design the wrong vocabulary.
- **Server-side per-connection egress tap** and a **pcap sidecar** (decision 3) — the first needs a
  `ServerTransport` wrapper, the second needs privileged containers. Revisit if the report leaves
  server→client questions unanswered, or if F3 lands and gossipsub control overhead needs watching.
- **CI gating** (decision 2) and **RabbitMQ / ZeroMQ profiles** (decision 8).
