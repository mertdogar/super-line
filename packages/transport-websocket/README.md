# @super-line/transport-websocket

The default client↔server transport for [**super-line**](https://super-line.dogar.biz/) —
a Node [`ws`](https://github.com/websockets/ws) server transport plus a browser/Node client transport.
Every other super-line README installs this; reach for [`@super-line/transport-http`](https://www.npmjs.com/package/@super-line/transport-http),
[`@super-line/transport-libp2p`](https://www.npmjs.com/package/@super-line/transport-libp2p), or
[`@super-line/transport-loopback`](https://www.npmjs.com/package/@super-line/transport-loopback) only when you want a different wire.

```bash
pnpm add @super-line/transport-websocket
```

```ts
import { createServer } from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { api } from './contract'

const server = createServer()
const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
})
server.listen(3000)
```

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { api } from './contract'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
})
```

## How it works

- **Server** — attaches to your `http.Server` and handles the WebSocket `upgrade`, so it composes
  with Express/Fastify/Hono on the same port. The handshake (headers + query) is normalized to a
  `Handshake` and passed to your server's `authenticate`; rejected handshakes get a `401` before upgrade.
  Each accepted socket becomes a `RawConn`.
- **Client** — dials one server URL per `connect`, sending handshake params as query string. Uses the
  global `WebSocket` (browser, or Node 22+); pass `WebSocket` to override.
- **Reserved connections** — when a server plugin declares a reserved connection class (e.g.
  [`@super-line/plugin-inspector`](https://www.npmjs.com/package/@super-line/plugin-inspector)'s
  `superline.inspector.v1` subprotocol, which the
  [Control Center](https://www.npmjs.com/package/@super-line/control-center) attaches over), the
  transport negotiates that subprotocol and short-circuits `authenticate` for those connections.
  Nothing is advertised unless a plugin declares it.

## Options

`webSocketServerTransport(opts)`:

| Option | Meaning |
| --- | --- |
| `server` | The `http.Server` to attach to (compose with Express/Fastify/Hono). |
| `path` | Only handle upgrades for this pathname; other upgrades are left untouched. |
| `backpressure` | Guard against slow consumers — see below. |

`webSocketClientTransport(opts)`:

| Option | Meaning |
| --- | --- |
| `url` | The server URL, e.g. `ws://localhost:3000`. |
| `WebSocket` | Override the WebSocket implementation (defaults to `globalThis.WebSocket`). |

`Backpressure` (`backpressure` option):

| Option | Meaning |
| --- | --- |
| `maxBufferedBytes` | Send-buffer size (bytes) above which `onExceed` kicks in. |
| `onExceed` | `'close'` (default) drops the connection with code `1013`; `'drop'` skips the frame. |

Low-level: `wsServerRawConn(ws, backpressure?)` wraps a raw `ws` socket as a `RawConn` (exported mainly for tests).

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [transports](https://super-line.dogar.biz/how-to/choose-a-transport)
- 🧩 Example: [`transports`](https://github.com/mertdogar/super-line/tree/main/examples/transports)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
