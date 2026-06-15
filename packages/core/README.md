# @super-line/core

Shared core for [**super-line**](https://mertdogar.github.io/super-line/) — end-to-end typesafe WebSockets for TypeScript. This package holds the pieces both ends import: `defineContract`, runtime validation, the `SocketError` model, and the `Serializer` / `Adapter` interfaces.

```bash
pnpm add @super-line/core zod
```

```ts
import { z } from 'zod'
import { defineContract } from '@super-line/core'

export const api = defineContract({
  shared: {
    serverToClient: { message: { payload: z.object({ text: z.string() }) } },
  },
  roles: {
    user: {
      clientToServer: {
        send: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
    },
  },
})
```

The contract is split by **direction** (`clientToServer` / `serverToClient`) and scoped by **role**, then implemented by [`@super-line/server`](https://www.npmjs.com/package/@super-line/server) and called by [`@super-line/client`](https://www.npmjs.com/package/@super-line/client).

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 The contract model: <https://mertdogar.github.io/super-line/guide/the-contract>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
