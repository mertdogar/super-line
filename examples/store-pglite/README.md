# store-pglite — self-clustering store over Postgres + Electric

A super-line cluster where the **store owns its cross-node sync** (`clustering: 'self'`) — the store needs
**no super-line adapter**; Postgres + Electric is its only fan-out infrastructure. These are **two
independent planes**:

```
  STORE plane (Electric):           writes + strong reads (postgres.js)
   node-1 ─┐
   node-2 ─┴──────────────────────────►  Postgres  (source of truth, wal_level=logical)
                                              │ logical replication
   each node also runs:                  [ Electric ]  HTTP /v1/shape
     in-memory PGlite + electricSync ◀────────┘ (one-way, read-only → local replica)
     live.changes() → fan to LOCAL subscribers

  COORDINATION plane (libp2p):  node-1 ⇄ node-2  broker-less gossipsub mesh, peers auto-found via mDNS
     carries presence + inspector (NOT the store) so the Control Center sees the whole cluster
```

- **Writes / strong reads / ACL** → central Postgres via `postgres.js`.
- **Subscriptions** → each node's in-memory PGlite replica, kept current by Electric, surfaced through
  `live.changes` and fanned to that node's local connections only.
- A write round-trips `node → Postgres → Electric → every node's replica`; the `origin` column carries
  super-line's echo-break through the round-trip.
- **The store never touches the adapter** (the `self` fan-out is local + Electric). The broker-less
  **libp2p adapter** is a *separate* plane that carries presence/inspector/rooms/topics — here it exists
  only so the Control Center can visualize the whole cluster. No extra container: the nodes peer directly.
- **Every node runs identical code with no cluster-size knowledge** — no node list, no bootstrap, no
  pre-computed peer IDs. Peers find each other over **mDNS** on the shared network; the server just dials
  what mDNS discovers. Add a node-3 and it joins the mesh with zero code or config change.

## Run

```bash
docker compose up --build
```

Watch the logs:

- `writer@node-1 → set count=N` — the writer (connected to **node-1**) increments the shared `room`.
- `reader@node-2 ← room count=N` — the reader (connected to **node-2**) sees each increment.

The reader receiving the writer's increments is the proof: the change crossed nodes through Electric,
not through any super-line adapter. You can also connect your own client to `ws://localhost:8801`
(node-1) or `ws://localhost:8802` (node-2).

### Control Center

The cluster also runs the [Control Center](../../packages/control-center) on **http://localhost:8081** —
a read-only inspector. It connects to node-1's inspector at `ws://localhost:8801/inspect`; because the
nodes share a libp2p presence mesh, the **Topology view shows the whole cluster** — node-1 + node-2 and
every connection (the writer on node-1, the reader on node-2) — plus the `docs` store and live `store.*`
traffic (writes, subscribes, deletes) from both nodes.

> Without the coordination-plane adapter the Topology would show only the node the Control Center is
> attached to: cross-node topology/presence is aggregated over the adapter, not over Electric (Electric is
> invisible to the inspector — it syncs store data, not super-line's cluster metadata).

## Notes

- The local PGlite replica is **in-memory** (ephemeral) — it re-syncs from Electric on boot.
- Electric runs in `ELECTRIC_INSECURE` mode here for local dev only.
- The store also runs unchanged against a real managed Postgres — point `PG_URL`/`ELECTRIC_URL` at it.
- Peer discovery is **mDNS** (multicast on the shared network). It needs a network that passes multicast —
  Docker's compose bridge does; many cloud/k8s networks don't. There, swap `mdns()` for a discovery that
  doesn't need multicast — e.g. `bootstrap` to one pinned seed + `@libp2p/pubsub-peer-discovery` (see
  `examples/libp2p-nat`), still without hardcoding the cluster size.
