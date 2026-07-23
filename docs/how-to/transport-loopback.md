# Loopback transport (testing)

Wire a **real** super-line server and client together in one process — no socket, no port, no `http.Server`. Provided by `@super-line/transport-loopback`.

```bash
pnpm add -D @super-line/core @super-line/transport-loopback
```

It's the in-memory analogue of the `Adapter`: messages cross directly between the two endpoints. That makes it ideal for fast, deterministic tests that exercise the *whole* stack — `authenticate`, validation, rooms, topics, the server→client request bus — without the flakiness or teardown of real sockets.

```ts
import { createLoopbackTransport } from '@super-line/transport-loopback'

const loopback = createLoopbackTransport()

const srv = createSuperLineServer(contract, {
  transports: [loopback.server],
  authenticate: (h) => ({ role: h.query.role, ctx: {} }),
})
srv.implement({ user: { echo: async ({ text }) => ({ text }) } })

const client = createSuperLineClient(contract, {
  transport: loopback.client(), // each call() returns a fresh client connection to the same server
  role: 'user',
  params: { name: 'alice' }, // handshake params arrive as h.query in authenticate
})

await client.echo({ text: 'hi' }) // a real round-trip through the real core, in-memory
```

## Why use it

- **Fast & deterministic** — no port binding, no socket timing, nothing to flake under parallel test load.
- **Real core** — it's not a mock. The same server and client run; only the wire is in-memory. A test that passes on loopback exercises the actual request/response, event, topic, and heartbeat paths.
- **Interface proof** — because the identical core runs over loopback and over WebSocket/HTTP/libp2p unchanged, it doubles as evidence the transport seam isn't WebSocket-shaped.

Loopback supports the full lifecycle — `close()`, `terminate()`, and `server.stop()` — so reconnect and disconnect tests work too. See [Testing](/how-to/testing) for the broader test-harness patterns.

Back to [Choose a transport](/how-to/choose-a-transport).
