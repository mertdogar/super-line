# @super-line/control-center

A zero-install debugging webapp for inspecting a running [super-line](https://github.com/mertdogar/super-line) platform — realtime topology, contract, roles, and per-connection ctx/state.

## Use

**1. Turn on the inspector** on each server node you want to reach (off by default):

```ts
import { webSocketServerTransport } from '@super-line/transport-websocket'

const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server, inspector: true })], // negotiates the inspector subprotocol
  authenticate,
  inspector: true, // gates the reserved `superline.inspector.v1` channel (server-authoritative)
})
```

The inspector is server-authoritative: pass `inspector: true` **both** on the server opts (to gate the telemetry) **and** on `webSocketServerTransport` (to negotiate the subprotocol).

**2. Run the Control Center** and point it at any node:

```sh
npx @super-line/control-center --url ws://localhost:3000
```

It serves the app locally and opens your browser. Switch endpoints from the connection bar, or pass `--port` to change the local port.

## What you get

- **Topology** — a hub-and-spoke graph: the Adapter/bus, server nodes (by friendly `nodeName`), and every connection (colored by **transport/wire**). Pick a room — or a wire family (ws / http / libp2p / loopback) — to highlight matching connections across nodes. Updates live.
- **Connections** — a table of every connection (role, **transport/wire**, user, node, rooms); click one for its descriptor plus a best-effort, node-local snapshot of `ctx` and `conn.data`.
- **Contract** — the full contract surface (roles × directions × message flavors) with best-effort JSON Schemas.
- **Live feed** — lifecycle events (connect / disconnect / room / topic) *and* message traffic (requests + responses, events, broadcasts, topic publishes), each tagged with the **wire** it rode, fanned out across the cluster in real time. Filter by category, node, or wire; pause; and expand any message row to its payload.
- **Stores** — browse each configured Store's Resources in a table you can filter by **id** (substring) or **granted users** (async, server-backed principal search), sort (id / users / created / updated), and page through; click a row for its live value + access rules. Filtering, sorting, and paging run server-side (`ServerStore.list` / `searchPrincipals`).
- **Settings** — configure the inspector WebSocket URL (saved to your browser). **Resources** — a page of links to the docs, repo, and npm.

Transport/wire is a first-class dimension throughout: connections carry a normalized `transport` (ws / http / libp2p / loopback), surfaced as a topology color + highlight, a Connections column, and a live-feed tag + filter.

## Security

The inspector channel is **read-only** but **unauthenticated** in v1, and `inspector: true` mirrors every message payload to the bus (an extra publish per message). Keep it to **local development or a trusted network** — never enable it on an internet-facing production node. Mask sensitive fields with `inspector: { redact: [...] }` (applies to `ctx`, `conn.data`, and message payloads).

See the [Control Center guide](https://mertdogar.github.io/super-line/guide/control-center) for details.

---

- 📦 npm: [`@super-line/control-center`](https://www.npmjs.com/package/@super-line/control-center) · v0.7.0
- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
