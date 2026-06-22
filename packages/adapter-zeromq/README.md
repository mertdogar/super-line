# @super-line/adapter-zeromq

ZeroMQ adapter for [**super-line**](https://mertdogar.github.io/super-line/) — fan out rooms, topics, and the cluster event bus (`server.publish` / `server.subscribe`) across multiple server processes, broker-free.

```bash
pnpm add @super-line/adapter-zeromq
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { createZeroMqAdapter } from '@super-line/adapter-zeromq'
import { api } from './contract'

const srv = createSuperLineServer(api, {
  server,
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

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [scaling & adapters](https://mertdogar.github.io/super-line/guide/scaling-adapters)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
