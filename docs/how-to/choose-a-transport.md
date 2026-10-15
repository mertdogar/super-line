# Choose and swap a transport

Pick the wire your client and server talk over, then change it in one line. The contract, handlers, roles, rooms, and topics above the transport are identical on every wire — [only the transport differs](/concepts/transports-and-adapters).

## Pick a wire

| If you need… | Use | Package |
|---|---|---|
| The default — lowest latency, full-duplex, broadest support | **WebSocket** | [`@super-line/transport-websocket`](/how-to/transport-websocket) |
| To survive restrictive networks / proxies that block or buffer WebSocket | **HTTP** (SSE or long-poll) | [`@super-line/transport-http`](/how-to/transport-http) |
| Peer-to-peer / **WebRTC** / WebTransport, browser↔server with no signaling code | **libp2p** | [`@super-line/transport-libp2p`](/how-to/transport-libp2p) |
| To host the server on **Cloudflare** — one Durable Object is one node, and it hibernates between events | **Cloudflare** (server side; clients use WebSocket) | [`@super-line/transport-cloudflare`](/how-to/cloudflare-durable-objects) |
| Fast, deterministic tests with a real server + client in one process | **Loopback** | [`@super-line/transport-loopback`](/how-to/transport-loopback) |

Start with WebSocket. Reach for HTTP as a fallback wire, libp2p when you want WebRTC/p2p, and loopback in your test suite. The Cloudflare transport is a server-side choice: it replaces the Node `http.Server` with a Durable Object, and clients keep dialing it over WebSocket.

## Swap the client transport

The transport is the only line that changes between wires:

```ts
// the ONLY thing that changes between wires:
webSocketClientTransport({ url: 'ws://localhost:3000' })   // WebSocket
httpClientTransport({ url: 'http://localhost:3000' })       // HTTP — SSE / long-poll
libp2pClientTransport({ node, multiaddr })                  // libp2p / WebRTC
loopbackTransport.client()                                  // in-memory (tests)
```

```ts
const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }), // ← swap this one line
  role: 'user',
})
await client.send({ room: 'lobby', text: 'hi' }) // identical on every wire
```

## Accept several wires at once

A server can accept multiple transports on one `http.Server`:

```ts
createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server }), httpServerTransport({ server })],
  authenticate,
})
```

WebSocket uses the HTTP `upgrade` channel and HTTP uses the `request` channel, so they coexist without collision — a browser that can't open a WebSocket falls back to HTTP against the very same server.

## Write auth once

`authenticate` always receives a normalized **Handshake** — the same shape regardless of transport — so your auth code doesn't change when you swap wires:

```ts
authenticate: (h) => {
  // h: { transport, headers, query, peer?, raw }
  const token = h.query.token        // WS/HTTP carry it on the URL; libp2p carries it in the first frame
  return { role: 'user', ctx: verify(token) }
}
```

::: tip Transports vs adapters
A **transport** is the *client↔server* wire (this page). An **adapter** is the *server↔server* fan-out substrate for multi-node clusters (Redis, libp2p, …). They're independent — you pick each separately. See [transports & adapters](/concepts/transports-and-adapters) and [choose an adapter](/how-to/choose-an-adapter).
:::

Configure each wire: [WebSocket](/how-to/transport-websocket) · [HTTP](/how-to/transport-http) · [libp2p & WebRTC](/how-to/transport-libp2p) · [Cloudflare Durable Objects](/how-to/cloudflare-durable-objects) · [Loopback](/how-to/transport-loopback). For the model — what every transport shares, why the seam is one line — see [transports & adapters](/concepts/transports-and-adapters).
