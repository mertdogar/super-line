# Same app, any wire

The headline of super-line's pluggable transports: **one contract, one server, identical client code — over WebSocket, HTTP, and libp2p at the same time.** The only thing that changes between wires is a single line.

```bash
pnpm --filter @super-line/example-transports start
```

## What it shows

A single server mounts **three transports** at once:

```ts
createSuperLineServer(api, {
  transports: [
    webSocketServerTransport({ server: httpServer }), // WS  — upgrade channel
    httpServerTransport({ server: httpServer }),        // HTTP — request channel (same http.Server!)
    libp2pServerTransport({ node }),                    // libp2p — its own node
  ],
  authenticate,
})
```

Then three clients call the **exact same** `echo` — only the transport line differs:

```ts
webSocketClientTransport({ url })           // WebSocket
httpClientTransport({ url, EventSource })   // HTTP / SSE
libp2pClientTransport({ node, multiaddr })  // libp2p
```

Output:

```
— same contract, every wire —
  client over websocket  →  "hello"  (server received it via "websocket")
  client over http/sse   →  "hello"  (server received it via "sse")
  client over libp2p     →  "hello"  (server received it via "libp2p")

— one server push, fanned to every wire —
  [websocket] announce: broadcast to all wires
  [http/sse]  announce: broadcast to all wires
  [libp2p]    announce: broadcast to all wires
```

Same handlers, same validation, same rooms/topics, same events — the transport is just the pipe. Swap it per deployment without touching a line of application code.
