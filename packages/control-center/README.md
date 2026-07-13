# @super-line/control-center

A zero-install debugging webapp for inspecting a running [super-line](https://github.com/mertdogar/super-line) platform — realtime topology, contract, roles, and per-connection ctx/state.

## Use

**1. Mount the inspector plugin** on each server node you want to reach (off by default):

```ts
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { inspector } from '@super-line/plugin-inspector'

const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  plugins: [inspector()], // taps telemetry + gates the reserved `superline.inspector.v1` channel
})
```

The inspector ships as [`@super-line/plugin-inspector`](https://www.npmjs.com/package/@super-line/plugin-inspector): mounting the plugin both taps every event and declares the reserved connection class the Control Center attaches to. (Earlier versions used an `inspector: true` server/transport option — that's gone; `inspector.redact` is now `inspector({ redact: ['token'] })`.)

**2. Run the Control Center** and point it at any node:

```sh
npx @super-line/control-center --url ws://localhost:3000
```

It serves the app locally and opens your browser. Switch endpoints from the connection bar, or pass `--port` to change the local port.

## What you get

- **Topology** — a hub-and-spoke graph: the Adapter/bus, server nodes (by friendly `nodeName`), and every connection (colored by **transport/wire**). Pick a room — or a wire family (ws / http / libp2p / loopback) — to highlight matching connections across nodes. Updates live.
- **Connections** — a table of every connection (role, **transport/wire**, user, node, rooms); click one for its descriptor plus a best-effort, node-local snapshot of `ctx` and `conn.data`.
- **Contract** — the full contract surface (roles × directions × message flavors) with best-effort JSON Schemas.
- **Live feed** — lifecycle events (connect / disconnect / room / topic), message traffic (requests + responses, events, broadcasts, topic publishes), *and* collection/CRDT traffic (`collection.*` row writes/changes, `crdt.*` document opens/writes/changes) — each tagged with the **wire** it rode, fanned out across the cluster in real time. Filter by category (Lifecycle / Requests / Events / Collections), node, or wire; pause; and expand any row to its payload (a `crdt.write` shows the decoded post-merge snapshot, not the opaque delta).
- **Collections** — a schema graph of your contract collections plus a row browser: query and page through each collection's rows (CRDT documents surface as `{ id, ...snapshot }` rows), and click one for its value. Backed by the inspector's `listCollections` / `queryCollection`.
- **Settings** — configure the inspector WebSocket URL (saved to your browser). **Resources** — a page of links to the docs, repo, and npm.

Transport/wire is a first-class dimension throughout: connections carry a normalized `transport` (ws / http / libp2p / loopback), surfaced as a topology color + highlight, a Connections column, and a live-feed tag + filter.

## Security

The inspector channel is **read-only** but **unauthenticated** in v1, and `inspector()` mirrors every message payload to the bus (an extra publish per message). Keep it to **local development or a trusted network** — never mount it on an internet-facing production node. Mask sensitive fields with `inspector({ redact: [...] })` (applies to `ctx`, `conn.data`, and message payloads).

See the [Control Center guide](https://super-line.dogar.biz/how-to/control-center) for details.

---

- 📦 npm: [`@super-line/control-center`](https://www.npmjs.com/package/@super-line/control-center) · v0.10.1
- 📖 Docs: <https://super-line.dogar.biz/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
