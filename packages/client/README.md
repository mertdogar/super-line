# @super-line/client

The client for [**super-line**](https://mertdogar.github.io/super-line/) — end-to-end typesafe WebSockets for TypeScript. A typed proxy over the global `WebSocket`: call requests, listen to events, subscribe to topics — with auto-reconnect and at-most-once delivery.

```bash
pnpm add @super-line/core @super-line/client zod
```

```ts
import { createSuperLineClient } from '@super-line/client'
import { api } from './contract'

const client = createSuperLineClient(api, { url: 'ws://localhost:3000', role: 'user' })

client.on('message', (m) => console.log(m.text))   // typed
const sub = client.subscribe('prices', (p) => render(p))
await sub.ready

const out = await client.send({ text: 'hi' })       // throws typed SuperLineError on failure
client.close()
```

The client is narrowed to its `role`'s surface (`shared ∪ role`). Works in browsers and Node 22+ (pass `{ WebSocket }` on older runtimes).

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guides: [requests](https://mertdogar.github.io/super-line/guide/requests), [reconnection & delivery](https://mertdogar.github.io/super-line/guide/reconnection-delivery)
- 📕 API reference: <https://mertdogar.github.io/super-line/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
