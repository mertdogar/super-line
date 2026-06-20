# @super-line/control-center

A zero-install debugging webapp for inspecting a running [super-line](https://github.com/mertdogar/super-line) platform — realtime topology, contract, roles, and per-connection ctx/state.

## Use

**1. Turn on the inspector** on each server node you want to reach (off by default):

```ts
const srv = createSocketServer(contract, {
  server,
  authenticate,
  inspector: true, // exposes the reserved `superline.inspector.v1` WS channel
})
```

**2. Run the Control Center** and point it at any node:

```sh
npx @super-line/control-center --url ws://localhost:3000
```

It serves the app locally and opens your browser. Switch endpoints from the connection bar, or pass `--port` to change the local port.

## What you get

- **Topology** — a hub-and-spoke graph: the Adapter/bus, server nodes, and every connection (colored by role). Pick a room to highlight its members across nodes. Updates live.
- **Connections** — a table of every connection; click one for its descriptor plus a best-effort, node-local snapshot of `ctx` and `conn.data`.
- **Contract** — the full contract surface (roles × directions × message flavors) with best-effort JSON Schemas.
- **Live feed** — connect / disconnect / room / topic events, fanned out across the cluster in real time.

## Security

The inspector channel is **read-only** but **unauthenticated** in v1. Keep `inspector: true` to **local development or a trusted network** — never enable it on an internet-facing production node.

See the [Control Center guide](https://mertdogar.github.io/super-line/guide/control-center) for details.
