# How data moves: transports and adapters

super-line has two pluggable seams for moving bytes, and keeping them straight is the key to reasoning about any deployment. A **transport** carries client↔server traffic. An **adapter** carries server↔server fan-out. They are orthogonal — you choose each independently — and neither one knows anything about your contract.

## What travels vs. how it travels

super-line separates **what** travels — your typed contract: requests, events, topics, validated and routed by a server-authoritative core — from **how** it travels. The core is the constant; the two seams are the variables. The same server, the same client, and the same handlers run unchanged over any transport and any adapter. Both seams move opaque bytes over a *logical* connection and never inspect a frame; everything meaningful — validation, roles, rooms, topics, serialization, reconnect — lives above them in the core.

## The transport — the client↔server wire

A transport is the physical pipe between a client and a server. The server takes `transports: [...]` (it can accept several at once on one HTTP server); the client takes a single `transport:`. Swapping the wire is one line — everything above it is identical:

```ts
// the ONLY thing that changes between wires:
webSocketClientTransport({ url: 'ws://localhost:3000' })   // WebSocket
httpClientTransport({ url: 'http://localhost:3000' })       // HTTP — SSE / long-poll
libp2pClientTransport({ node, multiaddr })                  // libp2p / WebRTC
loopbackTransport.client()                                  // in-memory (tests)
```

Four wires, each for a different constraint:

| Wire | Reach for it when… |
|---|---|
| **WebSocket** | the default — lowest latency, full-duplex, broadest support |
| **HTTP** (SSE / long-poll) | you must survive restrictive networks or proxies that block or buffer WebSocket |
| **libp2p / WebRTC** | you want peer-to-peer, browser↔server with no signaling code |
| **Loopback** | fast, deterministic tests with a real server + client in one process |

Because WebSocket rides the HTTP `upgrade` channel and HTTP rides the `request` channel, both coexist on one server — a browser that can't open a WebSocket can fall back to HTTP against the very same process. The setup steps are in [Choose a transport](/how-to/choose-a-transport).

### One handshake, every wire

`authenticate` always receives a normalized **Handshake** — the same `{ transport, headers, query, peer?, raw }` shape regardless of which transport carried the connection — so your auth code is written once and doesn't branch on the wire. The transport hides *physical* churn (HTTP's many requests, SSE reconnects, peer re-dials) beneath a single *logical* connection that re-authenticates and re-subscribes on drop — there is no session resume. See [Reconnection & delivery](/concepts/reconnection-delivery).

## The adapter — the server↔server fan-out

A single server uses an in-memory adapter — rooms and topics fan out within that one process. To run **more than one process** behind a load balancer, every server shares an **adapter** so fan-out crosses nodes. Rooms, topics, and the [cluster event bus](/how-to/cluster-event-bus) all compile down to channel pub/sub behind the `Adapter` interface; the adapter is the substrate that carries a `room.broadcast`, a `server.publish`, or a cluster-bus message from the node that originated it to the nodes holding the recipients. At-most-once delivery is preserved.

| Adapter | Reach for it when… | Presence |
|---|---|---|
| **Redis** | the pragmatic default for a backend cluster | strong, central broker |
| **RabbitMQ** | you already run it, or want selective per-channel routing | gossip (eventual) |
| **ZeroMQ** | you want the lightest broker-less option | gossip (eventual) |
| **libp2p** | decentralized self-hosted / edge, with NAT traversal | gossip (eventual) |

All four implement the same `Adapter` seam, so switching is a one-line change; the three broker-less options trade central presence for one fewer service to run. Setup lives in [Choose an adapter](/how-to/choose-an-adapter).

## The two seams are orthogonal

The transport and the adapter answer different questions and don't constrain each other:

| Seam | Axis | Question it answers | Configured on |
|---|---|---|---|
| **Transport** | client ↔ server | which wire a browser or peer speaks | client `transport:` · server `transports:` |
| **Adapter** | server ↔ server | how nodes fan out to each other | server `adapter:` |

You might run WebSocket clients over a Redis-backed cluster, HTTP-fallback clients over a libp2p mesh, or loopback clients with no adapter at all in a test suite. The core doesn't care; each seam is chosen on its own merits. Don't confuse them: transports carry client↔server bytes, adapters carry node↔node fan-out.

## The exception: `clustering: 'self'` collection backends

There is one case where the adapter steps aside. A `self`-tier collection backend (`collections-pglite`, `collections-crdt-pglite`) owns a **central Postgres** plus a **per-node Electric-synced replica**. Fan-out for that collection's state rides Electric's replication stream, not the adapter — the backend is its own bus. So a `self` backend **bypasses the adapter entirely** for its rows or documents, even though rooms, topics, and the cluster event bus on the same server still use whatever adapter you configured.

::: tip Three carriers, not two
For a `self`-collection deployment the full picture is three carriers: the **transport** moves client↔server bytes, the **adapter** moves node↔node fan-out for rooms/topics/bus, and a **`self` collection backend** moves its own state over Postgres + Electric and needs neither.
:::

See [Backends & clustering](/collections/backends) for the relay-vs-`self` distinction, and [Server-authoritative by design](/concepts/server-authoritative) for why the server stays the authority no matter how the bytes travel.
