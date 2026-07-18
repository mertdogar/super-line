# react-chat-cluster-libp2p — chat across two servers, no broker

The [`react-chat-cluster`](../react-chat-cluster) example runs the same chat behind two nodes
using a **Redis** broker. This one is identical — same React SPA, same Control Center — but with
**no broker at all**: the two nodes peer directly over [libp2p](https://libp2p.io) gossipsub via
[`@super-line/adapter-libp2p`](../../packages/adapter-libp2p). Open the app in several tabs, watch
each land on a *different* server, and chat between them — every message crossing process
boundaries over the peer-to-peer mesh.

A single **Caddy** container serves the built React SPA *and* reverse-proxies the WebSocket,
`round_robin`-ing each connection across the nodes:

```
browser :8090 ── web (Caddy) ┬─ GET /    → the vite-built SPA
                             └─ WS  /ws  → round_robin → node-1 / node-2
                                                          └─ libp2p gossipsub mesh ─┘
                                                               (no broker, peer-to-peer)
```

## Run it

```bash
cd examples/react-chat-cluster-libp2p
docker compose up --build   # boots 2 nodes + web + the Control Center — NO redis
```

> Use `--build`. The node image bakes the TypeScript source in at build time, so without it
> `docker compose up` silently reuses a stale image. Unchanged layers are cached, so a no-op
> rebuild is fast.

Open <http://localhost:8090> in **two or more tabs** (same browser is fine). Pick a name in each,
join the same room. (Ports are offset from the Redis `react-chat-cluster`, so both can run at once.)

## How discovery works (no broker)

Without a broker, each node has to *dial* the other. This demo derives a **deterministic Ed25519
key from each node name**, so every node can compute the other's peer ID and build the bootstrap
list with no registry:

```ts
const bootstrap = NODES.filter((n) => n !== NODE).map(
  async (n) => `/dns4/${n}/tcp/${P2P_PORT}/p2p/${peerIdFromPrivateKey(await keyFor(n))}`,
)
adapter: await createLibp2pAdapter({ identity: myKey, listen: [`/ip4/0.0.0.0/tcp/${P2P_PORT}`], bootstrap })
```

> **Demo shortcut.** Deterministic keys keep the example registry-free. A real deployment persists
> each node's key — `createLibp2pAdapter({ identity: { path: '/var/lib/app/p2p' } })` — so a node's
> peer ID (and its bootstrap multiaddr) survives restarts, and runs ≥2 stable seed nodes.

## Inspect it with the Control Center

`docker compose up` also boots the [Control Center](../../packages/control-center) at
<http://localhost:8091> — a live view of this exact cluster:

- the **topology** graph — `node-1`, `node-2`, and the adapter bus (here the libp2p mesh), with
  each chat tab's connection hanging off the node it landed on;
- the **live feed** — lifecycle events *and* the actual message traffic (`join`, the `message`
  broadcast, the `presence` publish) as they cross nodes over the mesh in real time;
- the **contract** explorer and a per-connection drawer.

The nodes run with `plugins: [inspector()]` (from `@super-line/plugin-inspector`), and Caddy pins
`/inspect` to **node-1**, so node-1's connections show their live `ctx` (the chat `name`) while
node-2's show the cross-node `ctxAvailable: false` boundary — node-local `ctx` never leaves its
node.

> The inspector channel is **read-only but unauthenticated** (dev/trusted-network only). The
> inspector rides the WebSocket, not the adapter, so it works identically over libp2p.

## What you'll see

- **Each tab shows its node** in the header; `round_robin` puts the first two tabs on different servers.
- **Messages cross servers** over the gossipsub mesh — type in the node-1 tab, it appears in the
  node-2 tab tagged `ada@node-1`. No broker is involved.
- **The online count is cluster-wide**, from the adapter's gossip-replicated presence directory
  (`srv.cluster.room(room)`).

> Presence here is **eventually consistent** — the libp2p adapter replicates it by gossip (deltas +
> periodic snapshots) rather than a central store, so a cross-node count can lag by a fraction of a
> second under churn before it settles. (The Redis variant is fire-and-forget too, just centrally
> consistent.) A tab is bound to its node for the life of its WebSocket; reload to re-sync after a
> reconnect.

## Stop

`Ctrl-C`, then `docker compose down`.

## How it maps to super-line

The **only** structural change from [`react-chat-cluster`](../react-chat-cluster) is the adapter:
`createRedisAdapter(REDIS_URL)` becomes `await createLibp2pAdapter({ identity, listen, bootstrap })`
plus the deterministic-key derivation. The contract, the React SPA, the Control Center, presence,
and the inspector are all unchanged — the `Adapter` seam is what makes the swap a one-liner.
