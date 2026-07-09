# HTTP transport — SSE & long-poll

For environments where WebSocket is blocked or buffered (corporate proxies, some load balancers, locked-down networks), super-line runs over plain HTTP: a **Server-Sent Events** stream or **long-poll** downstream, plus a `POST` upstream — all over one logical connection. Provided by `@super-line/transport-http`.

```bash
pnpm add @super-line/transport-http
```

It carries the exact same contract as WebSocket. The transport hides the HTTP mechanics — the session that spans many requests, EventSource reconnects — so the core still sees one logical connection.

## Server

Mount it on an `http.Server` — including **the same one your WebSocket transport uses** (WS owns the `upgrade` channel, HTTP owns `request`, so they coexist):

```ts
import { httpServerTransport } from '@super-line/transport-http'
import { webSocketServerTransport } from '@super-line/transport-websocket'

createSuperLineServer(contract, {
  transports: [
    webSocketServerTransport({ server }), // preferred wire
    httpServerTransport({ server }),       // automatic fallback on the same server
  ],
  authenticate,
})
```

**Options:** `basePath` (default `/superline`), `mode` (`'sse' | 'longpoll' | 'both'`, default `'both'`), `sessionTimeout`, `keepalive` (SSE comment interval), `pollTimeout`, `maxBodyBytes`, `cors`.

## Client

In a **browser**, `EventSource` and `fetch` are globals — nothing to configure:

```ts
import { httpClientTransport } from '@super-line/transport-http'

createSuperLineClient(contract, {
  transport: httpClientTransport({ url: 'https://api.example.com', mode: 'sse' }),
  role: 'user',
})
```

In **Node**, `EventSource` is **not** a global (even in current versions). For SSE mode, inject one — the [`eventsource`](https://www.npmjs.com/package/eventsource) package:

```ts
import { EventSource } from 'eventsource'
httpClientTransport({ url, EventSource })        // SSE
httpClientTransport({ url, mode: 'longpoll' })   // long-poll needs only `fetch`
```

## SSE vs long-poll

| | SSE | long-poll |
|---|---|---|
| Downstream | a held `text/event-stream` (EventSource) | a sequence of held `GET`s that return and re-issue |
| Needs `EventSource` | yes (browser global; Node: inject) | no — `fetch` only |
| Behind SSE-buffering proxies | can stall | works (plain request/response) |

Prefer **SSE**; switch to **`mode: 'longpoll'`** behind proxies that buffer event streams.

## Notes

- **Heavier than WebSocket for large binary payloads** — frames are base64-encoded to travel safely over an SSE `data:` line or a JSON body (≈ +33%). It's the compatibility/fallback wire, not the performance wire.
- The transport sets `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no` and writes periodic keepalive comments to survive idle-proxy reaping.
- Same `authenticate(handshake)`, same app-level ping/pong liveness, same reconnect model as every wire.

Next: [libp2p & WebRTC](/how-to/transport-libp2p) · back to [Choose a transport](/how-to/choose-a-transport).
