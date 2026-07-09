# @super-line/adapter-zeromq

ZeroMQ adapter for [**super-line**](https://super-line.dogar.biz/) — fan out rooms, topics, and the cluster event bus (`server.publish` / `server.subscribe`) across multiple server processes, broker-free.

```bash
pnpm add @super-line/adapter-zeromq
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  adapter: await createZeroMqAdapter({
    bind: 'tcp://0.0.0.0:5555',
    peers: ['tcp://node-b:5555', 'tcp://node-c:5555'],
  }),
})
```

Each node binds a PUB socket and connects to its peers — a brokerless mesh, no central server to run. Without an adapter, a single node uses the built-in in-memory adapter — add this only when you scale out. At-most-once delivery; `zeromq` is a native addon. For a large fan-out you can run the bundled forwarder proxy instead of a full mesh:

```bash
super-line-zeromq-proxy --xsub tcp://0.0.0.0:5555 --xpub tcp://0.0.0.0:5556
```

## Options

`createZeroMqAdapter` has three shapes — **mesh** (default), **proxy** (`mode: 'proxy'`), and **BYO** (hand in pre-wired sockets). All share `presence` and `sendHighWaterMark`.

| Option | Mode | Meaning |
| --- | --- | --- |
| `bind` | mesh | This node's PUB endpoint to bind (e.g. `tcp://0.0.0.0:5555`, or `tcp://127.0.0.1:0` for an OS-picked port — read it back from the returned `endpoint`). |
| `peers` | mesh | Other nodes' PUB endpoints to connect a SUB to. Lazy + auto-reconnecting, so peers may start in any order. |
| `frontendUrl` / `backendUrl` | proxy | The proxy's XSUB / XPUB endpoints — this node's PUB connects to the front, its SUB to the back. |
| `pub` / `sub` | BYO | Pre-wired sockets used as-is; the adapter does NOT own their lifecycle (`close()` leaves them open). |
| `sendHighWaterMark` | mesh / proxy | Messages buffered per peer before silent drops (default `100_000`). |
| `presence` | all | `false` to disable, or `{ snapshotIntervalMs, livenessTtlMs }` to tune. |

**Presence** — a gossip-replicated directory rides a reserved internal channel (no central store, fitting the brokerless mesh) and powers `srv.cluster.*` / `srv.isOnline`. On by default; pass `presence: false` to disable (cluster queries then throw).

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [scaling & adapters](https://super-line.dogar.biz/how-to/choose-an-adapter)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
