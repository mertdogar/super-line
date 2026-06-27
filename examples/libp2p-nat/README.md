# example: libp2p-nat (servers behind NAT, browsers over WebRTC)

A super-line chat cluster where **the servers are not directly reachable** — their libp2p nodes
advertise *only* a `/p2p-circuit` relay reservation and `/webrtc`. Browser clients, sitting outside
the network entirely, reach them by **WebRTC**, signalled through a single public relay. The same
relay also lets the servers discover and mesh with each other. One small public node; everything
else behind NAT.

It reuses the [`react-chat-cluster-libp2p`](../react-chat-cluster-libp2p) chat contract and UI nearly
unchanged — the *connectivity* (and a little header copy) is all that really differs. The super-line
packages are unchanged: one libp2p node per server feeds both the libp2p **transport**
(browser↔server) and the libp2p **adapter** (server↔server).

## Run it

```bash
cd examples/libp2p-nat && docker compose up --build
```

- **http://localhost:8080** — the chat. Open two tabs, pick different names; messages cross nodes.
- **http://localhost:8091** — the Control Center. Watch each connection's transport (`webrtc` for
  clients, the cluster mesh for servers) and the live topology.

Or run it locally without docker (four terminals from this dir):

```bash
pnpm relay                       # the public relay on ws://127.0.0.1:9000
NODE_NAME=node-1 INSPECTOR_PORT=7400 pnpm server   # 7400, not 7000 — macOS AirPlay squats :7000
NODE_NAME=node-2 pnpm server
pnpm dev                         # the SPA — open the printed URL
pnpm probe                       # optional: a headless client that proves the path with no browser
```

## How the connectivity works

```
 Browser (libp2p node, no listener)                 Server node-1 / node-2  (listen: /p2p-circuit,/webrtc)
        │  ws→ relay (bootstrap + pubsub)                    │  ws→ relay (reserve a slot + pubsub)
        │  discover a server via pubsub-peer-discovery       │  discover each other, dial → gossipsub mesh
        ▼                                                    ▼
   ┌──────────────────────────  RELAY (the one public node)  ──────────────────────────┐
   │  circuit-relay-v2  ·  gossipsub router  ·  pubsub-discovery topic bridge           │
   └───────────────────────────────────────────────────────────────────────────────────┘
        │  /p2p-circuit/webrtc/p2p/<server>   (SDP signalling rides the relay)
        ▼
   Browser ═══════════ direct WebRTC (hole-punched) ═══════════ Server   ← super-line RPC flows here
```

- **NAT is a libp2p-config fact**, not docker plumbing: servers never advertise a dialable address,
  so discovery, first contact and SDP signalling are *forced* through the relay. The actual data
  path is a direct WebRTC connection. (libp2p WebRTC has no data-relay fallback — direct or nothing.)
- **STUN makes it cross real NATs.** WebRTC is given public STUN servers (`src/ice.ts`) so each peer
  discovers its hole-punchable public address — that's what lets a phone on cellular reach a server
  behind a home router. Without it only host candidates are gathered (fine on one LAN, not across
  networks). Genuinely *symmetric* NATs still need a TURN relay, which this example doesn't run.
- **Discovery is `@libp2p/pubsub-peer-discovery`** over the gossipsub mesh the adapter already runs.
  The relay bridges the discovery topic; servers find each other, browsers find a server. Because
  pubsub carries no role info, peers are role-filtered against a **known-server set** (servers have
  deterministic identities) — so servers only mesh-dial servers, and browsers only connect to
  servers, never to each other. The browser bundle gets the servers' *public* PeerIds at build time;
  no private key ever reaches it.
- **The Control Center** connects over a normal WebSocket inspector port on node-1 (an out-of-band
  management channel — *not* how app clients connect). Inspector telemetry is cluster-wide, so that
  one gateway shows every node and every webrtc client.

## Single-host honesty

On one machine, every container is reachable, so the "direct WebRTC" path forms trivially — this
demonstrates the *wiring*, not a real symmetric-NAT hole-punch (which needs genuinely separate
networks). It does cross one real boundary, though: `pnpm probe` runs on the **host** and still
reaches a NAT'd server *inside* docker over webrtc-through-relay (a full chat round-trip) — so the
signalling and WebRTC upgrade are exercised end to end, just without a hostile NAT in the middle.
For a true cross-NAT test, deploy the relay on a public host and run the servers on different real
networks; the code is identical, only `RELAY_HOST` changes.

> Native dep: the servers use `@libp2p/webrtc`, which builds `node-datachannel` on install (allow-listed
> in `pnpm-workspace.yaml`). The relay and browser bundle don't need it.
