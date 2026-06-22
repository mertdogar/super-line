# react-chat-transports — same chat, any wire

A React chat with a **transport dial**: flip between **WebSocket**, **HTTP (SSE)**, and **libp2p** live, in the browser. The contract, the handlers, the hooks, the UI — all identical. Only the transport line changes, and the chat keeps working; each message even shows the wire it arrived on.

## Run it

```bash
cd examples/react-chat-transports
docker compose up --build
```

- **Chat** → http://localhost:8100 — join, then use the **transport** dropdown in the header.
- **Control Center** → http://localhost:8101 — watch the same connection switch transports live.

### Or locally (no Docker)

```bash
# terminal 1 — the server (WS + HTTP on :8787, libp2p /ws on :9101)
pnpm --filter @super-line/example-react-chat-transports server
# terminal 2 — the SPA (vite proxies WS/HTTP/libp2p-addr to the server)
pnpm --filter @super-line/example-react-chat-transports dev
```

## How it works

One server mounts all three **server** transports:

```ts
createSuperLineServer(chat, {
  transports: [
    webSocketServerTransport({ server, inspector: true }), // WS  — http upgrade channel
    httpServerTransport({ server }),                        // HTTP — http request channel (same server)
    libp2pServerTransport({ node }),                        // libp2p — a started libp2p node
  ],
  authenticate: (h) => ({ role: 'user', ctx: { name: h.query.name, via: h.transport } }),
})
```

The browser's dial picks the **client** transport (`src/transport.ts`) — the one line that differs:

```ts
webSocketClientTransport({ url })            // WebSocket
httpClientTransport({ url })                 // HTTP / SSE  (EventSource + fetch are browser globals)
libp2pClientTransport({ node, multiaddr })   // libp2p over a browser libp2p node
```

`authenticate` puts `h.transport` into `ctx`, so every message carries `via` — the header shows *connected over
websocket / http / libp2p*, and each line shows the sender's wire. Switching the dial rebuilds the client on the
new transport while the message history (lifted above the re-keyed chat subtree) persists.

## Notes

- **libp2p wire = libp2p-over-WebSockets.** The browser builds a libp2p node (`@libp2p/websockets` + noise + yamux)
  and dials the server's `/ws` multiaddr (the server publishes its port + stable PeerId at `GET /libp2p-addr`,
  which the browser fetches and dials **directly** — not through Caddy). This is the reliable browser↔server libp2p
  path on localhost.
- **WebRTC** is a node-config swap, not a code change: give the browser and server libp2p nodes `@libp2p/webrtc`
  (`webRTCDirect()` to a public-UDP server, or relayed `webRTC()` via a `circuit-relay-v2` container) and the same
  `libp2pClientTransport`/`libp2pServerTransport` carry the chat over a WebRTC data channel. See the
  [libp2p & WebRTC transport guide](../../docs/guide/transport-libp2p.md).
- Single node by design — this example showcases three *client* transports to one server. For *server↔server*
  fan-out across nodes, see the `react-chat-cluster-*` examples (that's the `Adapter`, a separate axis).
