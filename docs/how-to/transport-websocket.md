# WebSocket transport

The default wire: a full-duplex WebSocket. Lowest latency, broadest support, and the closest match to a classic realtime connection. Provided by `@super-line/transport-websocket`.

```bash
pnpm add @super-line/transport-websocket
```

## Server

`webSocketServerTransport` attaches to an `http.Server` — compose it with Express/Fastify/Hono, or a bare `http.createServer()`.

```ts
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'

const server = http.createServer()
const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server })],
  authenticate: (h) => ({ role: h.query.role, ctx: verify(h.query.token) }),
})
server.listen(3000)
```

**Options:**

| Option | Default | Notes |
|---|---|---|
| `server` | — | the `http.Server` to attach to (required) |
| `path` | any | only handle upgrades for this pathname; others pass through |
| `backpressure` | off | `{ maxBufferedBytes, onExceed: 'close' \| 'drop' }` — guard against slow consumers (the byte-buffer threshold is WS-specific) |
| `inspector` | off | accept Control Center inspector clients on the `superline.inspector.v1` subprotocol — see [Control Center](/how-to/control-center) |

`path`, `backpressure`, and `inspector` are WebSocket-transport concerns, so they live on the transport, not on the server.

## Client

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'

const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  params: { token }, // carried on the URL query → readable as h.query.token in authenticate
})
```

In a **browser** (and Node 22+), `WebSocket` is a global — nothing to configure. On **older Node**, pass an implementation:

```ts
import WebSocket from 'ws'
webSocketClientTransport({ url, WebSocket })
```

## Behavior notes

- A rejected `authenticate` becomes a **`401` at the HTTP upgrade with no socket opened** — efficient, and a real status. (To the client this looks like a connection drop; see [Reconnection & delivery](/concepts/reconnection-delivery).)
- Heartbeat is **app-level ping/pong frames** the core manages — not the WebSocket protocol ping — so it's identical across every transport.
- `params` (and `role`) ride the URL query string and surface in `authenticate` as `h.query`.

Next: [HTTP — SSE & long-poll](/how-to/transport-http) · back to [Choose a transport](/how-to/choose-a-transport).
