# Control Center

The **Control Center** is a debugging webapp for inspecting a running super-line platform: a realtime topology diagram, the contract, connection roles, and per-connection `ctx`/state. It ships as `@super-line/control-center` and runs with `npx` — no install.

## Enable the inspector

The Control Center connects over a reserved WebSocket subprotocol (`superline.inspector.v1`). Turn it on per node with one option (it is **off by default**):

```ts
import { createSocketServer } from '@super-line/server'

const srv = createSocketServer(contract, {
  server,
  authenticate,
  inspector: true,
})
```

Inspector connections **bypass `authenticate`**, are **read-only**, and are kept out of presence, the heartbeat, and `local`/`cluster` results — so the observer never shows up in what it observes.

::: warning Dev / trusted-network only
The inspector channel is unauthenticated in v1. Never enable `inspector: true` on an internet-facing production node. (A `redact` option lets you hide specific `ctx`/`data` field names: `inspector: { redact: ['token'] }`.)
:::

## Run it

```sh
npx @super-line/control-center --url ws://localhost:3000
```

This serves the app on a local port and opens your browser. Change the endpoint from the connection bar at any time, or pass `--port` to pick the local port.

## The views

- **Topology** — a hub-and-spoke graph. The Adapter/bus sits at the center (multi-node clusters only — nodes have no direct sockets, they coordinate through the bus), server nodes around it, and each connection around its owning node. Connections are colored by role; selecting a room highlights its members across the whole cluster. The graph updates on every live event.
- **Connections** — a table of every connection cluster-wide. Click a row to open its descriptor plus a best-effort, **node-local** snapshot of `ctx` and `conn.data`. A connection owned by another node shows descriptor-only (point the Control Center at that node to read its `ctx`).
- **Contract** — the full contract surface: `shared`, each role, and `serverToServer`, split by direction with a flavor badge (`request` / `event` / `topic` / `serverRequest` / `serverEvent`) and an expandable best-effort JSON Schema per message.
- **Live feed** — `connect` / `disconnect` / `room.add` / `room.remove` / `topic.sub` / `topic.unsub` events, published on a reserved channel and fanned out cluster-wide via your Adapter, so an inspector on any one node sees churn from every node.

## How it works

Everything rides the WebSocket transport super-line already owns — the Control Center is itself a super-line-style client on the reserved channel. Contract structure comes from the in-process contract object; field-level schemas use the optional [`@standard-community/standard-json`](https://github.com/standard-community/standard-json) bridge when present, falling back to structure-only otherwise. Cluster reads come from the [presence registry](/guide/introspection-and-presence); live events reuse the same Adapter pub/sub fan-out as rooms and topics.

> **v2 (planned):** message inspection with history, built on the same live channel.
