# @super-line/transport-http

HTTP client↔server transport for [**super-line**](https://mertdogar.github.io/super-line/) — runs the
full data bus (requests · events · subscriptions · synced state) over plain HTTP for
**WebSocket-hostile networks**: SSE or long-poll downstream + `POST` upstream over one logical connection.
A drop-in alternative to the default [`@super-line/transport-websocket`](https://www.npmjs.com/package/@super-line/transport-websocket).

```bash
pnpm add @super-line/transport-http
```

```ts
// server — compose on the SAME http.Server as your other transports
import { createServer } from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { httpServerTransport } from '@super-line/transport-http'
import { api } from './contract'

const server = createServer()
createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server }), httpServerTransport({ server })],
  authenticate,
})
server.listen(3000)
```

```ts
// client — Node has no global EventSource, so pass the `eventsource` package
import { createSuperLineClient } from '@super-line/client'
import { httpClientTransport } from '@super-line/transport-http'
import { EventSource } from 'eventsource'
import { api } from './contract'

const client = createSuperLineClient(api, {
  transport: httpClientTransport({ url: 'http://localhost:3000', EventSource }),
})
```

In the browser `EventSource` and `fetch` are globals, so `httpClientTransport({ url })` is enough.

## How it works

- **One logical connection over HTTP** — a downstream channel for server→client pushes plus `POST /send`
  for client→server frames, keyed by a server-minted session id. No WebSocket upgrade, so it survives
  proxies, corporate firewalls, and CDNs that strip `Upgrade`.
- **Downstream `mode`** — `'sse'` (default) holds an open `text/event-stream`; keepalive comments keep it
  alive through idle-proxy reaping. `'longpoll'` holds a GET open up to `pollTimeout`, returns, and re-polls.
- **Reconnect** — a dropped downstream is physical churn hidden from core: idle sessions are reaped after
  `sessionTimeout`, and on `410` the client re-auths into a fresh session and resends unsent frames.

## Server options — `httpServerTransport(opts)`

| Option | Meaning |
| --- | --- |
| `server` | The `http.Server` to attach to (compose alongside `webSocketServerTransport` on one server). **Required.** |
| `basePath` | URL prefix for this transport's routes (default `/superline`). Requests outside it pass through untouched. |
| `sessionTimeout` | Idle grace before a session with no client activity is reaped, ms (default `60_000`). |
| `keepalive` | SSE keepalive comment interval, ms — survives idle-proxy reaping (default `20_000`). |
| `pollTimeout` | How long a long-poll request is held open before returning empty, ms (default `25_000`). |
| `maxBodyBytes` | Max `POST` body size; larger requests get `413` (default `1_000_000`). |
| `cors` | Opt-in CORS for cross-origin browser clients: `{ origin? }` (default `*`). |

## Client options — `httpClientTransport(opts)`

| Option | Meaning |
| --- | --- |
| `url` | The server origin, e.g. `http://localhost:3000`. **Required.** |
| `basePath` | URL prefix; MUST match the server's (default `/superline`). |
| `mode` | Downstream mechanism, `'sse'` or `'longpoll'` (default `'sse'`). |
| `EventSource` | EventSource implementation — undefined in Node, so pass the [`eventsource`](https://www.npmjs.com/package/eventsource) package. |
| `fetch` | fetch implementation (defaults to `globalThis.fetch`, present in Node 18+ and browsers). |

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [HTTP transport](https://mertdogar.github.io/super-line/guide/transport-http)
- 🧩 Example: [`react-chat-transports`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-transports) — flip between WebSocket, HTTP (SSE), and libp2p live in the browser
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
