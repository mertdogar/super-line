# @super-line/traffic-lab

A permanent, private fixture that measures where super-line sends bytes nobody wanted.

Three nodes meshed over libp2p gossipsub (mDNS discovery), four clients **pinned** to specific nodes, and
a conductor — every actor its own container. It taps all four planes the bytes cross, classifies each
frame, and writes a report you can diff against a committed baseline.

Never published. Not part of any test lane — run it by hand when you change fan-out.

## Run it

```bash
cd packages/traffic-lab
node run.mjs                     # all four profiles, then the report
node run.mjs --only libp2p       # one adapter
node run.mjs --skip-run          # re-analyze dumps already on disk
node run.mjs --update-baseline   # rewrite baseline.json from this matrix
```

Output lands in `runs/report.md`, with per-actor NDJSON dumps under `runs/<profile>/`.

## What it measures

Four layers, **none of which puts a byte on the wire** — every tap writes to disk. That is the whole
point, and it is exactly what the inspector does not do (see the `observation` verdict below).

| | Seam | Answers |
|---|---|---|
| **L1** | server `onEvent` | what the app asked for — the denominator |
| **L2** | an `Adapter` decorator | per-channel publish/deliver/subscribe; also owns the interest mirror |
| **L3** | a second listener on the shared gossipsub topic | every frame that **arrived**, including ones the adapter discards |
| **L5** | client `onClientSideEvent` | the client wire, plus drops that never reach it |
| **+** | `/sys/class/net/eth0/statistics` | total interface bytes, for the overhead factor |

L3 is the only layer from which waste is visible at all: every super-line channel rides **one** gossipsub
topic, so a node receives, decrypts and decodes every frame the whole cluster publishes and then drops the
ones it has no local member for — privately, inside the adapter. The interest mirror in L2 is what lets L3
tell an accepted arrival from a discarded one without reaching into adapter internals.

## The experiment

Eleven phases separated by quiet gaps, each isolating one fan-out path. The **pairs** are the point:

- `emit-local` vs `emit-remote` — the same targeted emit, to a connection on the publishing node vs another
- `room-local` vs `room-spread` — the same broadcast, to a room entirely on one node vs one member per node

The difference between each pair is the cost of a publisher not knowing whether any other node wants the
frame (**remote interest**, in `CONTEXT.md`). Clients are pinned rather than load-balanced precisely so
these contrasts exist; a round-robin gateway would erase them.

Phase 0 is idle — no application traffic at all — which prices the fixed cost of a three-node cluster.

## Verdicts

Every frame is classified (the **delivery verdict** in `CONTEXT.md`):

- **useful** — a local subscriber wanted it.
- **by-design** — a real cost with a named reason: relay replication, presence gossip, permissive row
  routing. Reported, never indicted.
- **observation** — exists only because something is watching. The inspector republishes every event it
  observes cluster-wide, so this is a first-class category rather than a footnote.
- **waste** — removable with no observable change: discarded on arrival, a publish no node wanted, a mesh
  hop whose every interested member was local, a delivery no listener consumed.

The headline is the **acceptance ratio**: per node, frames delivered to a local listener ÷ frames that
arrived.

## Profiles

`{libp2p, redis} × {inspector off, on}` — four runs.

Redis is the control. It filters at the broker, so it has no mesh layer and its acceptance ratio is 1.0 by
construction; its job is to supply the bytes-and-publish-count reference that makes a libp2p number
interpretable. The inspector axis is a 2×2 rather than an on/off because the cost of republishing every
observed event is expected to depend on the adapter beneath it.

## Notes

- **mDNS needs no special networking.** Multicast crosses a user-defined Docker bridge; there is no
  `network_mode: host` and no bootstrap list.
- **Compose bind-mounts `src` directories**, so a code change takes effect on restart with no image
  rebuild. It covers the lab plus core, server, client, transport-websocket, plugin-inspector and
  adapter-libp2p. Do not edit those while a matrix run is in flight — the later profiles would measure
  different code.
- **The control plane is HTTP, never super-line.** Readiness, phase transitions and flush signals must not
  appear in the traffic being measured.
- **The mesh tap re-implements the libp2p adapter's private channel framing** (`src/tap/codec.ts`), pending
  a decision on exporting it. Duplication rots, so decoding a channel super-line could not have produced is
  a hard error rather than an unattributed frame.
- **CRDT creation is node-local** and does not relay, so the conductor seeds every node. A node that never
  ran a create answers `open` with `NOT_FOUND` forever.
