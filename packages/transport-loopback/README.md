# @super-line/transport-loopback

In-memory client↔server transport for [**super-line**](https://super-line.dogar.biz/) — a real server and client in one process, exchanging bytes directly with no sockets, ports, or network. The zero-dependency default for tests.

```bash
pnpm add -D @super-line/transport-loopback
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { contract } from './contract'

const loopback = createLoopbackTransport()

const srv = createSuperLineServer(contract, {
  transports: [loopback.server],
  authenticate: () => ({ role: 'user', principal: 'u1' }),
})

const client = createSuperLineClient(contract, {
  transport: loopback.client(),
  role: 'user',
})
```

`createLoopbackTransport()` returns `{ server, client }`: pass `server` to the server's `transports`, and call `client()` for each client's `transport`. Same `authenticate` / `Handshake` flow as any transport (`handshake.transport === 'loopback'`); query params from the client become the handshake's `query`.

## How it works

- **Real wire, no socket** — each `send` delivers to the peer on the next microtask, so ordering and the async edges (connect, message, close) behave like a real connection without timers or I/O.
- **Honest failures** — connecting with no server listening, a rejected `authenticate`, or `server.stop()` all surface as an abnormal close (`1006`), exactly as a dropped socket would.
- **Many clients, one server** — call `client()` per client; each gets its own linked pair against the shared server transport.

It mirrors the in-memory `Adapter`: a zero-dependency substrate that also proves the transport interface isn't WebSocket-shaped.

## API

| Export | Meaning |
| --- | --- |
| `createLoopbackTransport()` | Returns `{ server, client }`. |
| `.server` | A `ServerTransport` — put it in `createSuperLineServer(..., { transports: [server] })`. |
| `.client()` | Factory returning a fresh `ClientTransport` for `createSuperLineClient(..., { transport })`. Call once per client. |

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [testing](https://super-line.dogar.biz/how-to/testing)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
