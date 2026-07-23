# @super-line/react

React hooks for [**super-line**](https://super-line.dogar.biz/), the strictly-typed realtime data bus — typed `useRequest` / `useEvent` / `useSubscription` / `useCollection` / `useDoc` bound to a contract + role.

```bash
pnpm add @super-line/core @super-line/client @super-line/react
```

```tsx
import { useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createSuperLineHooks } from '@super-line/react'
import { api } from './contract'

const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof api, 'user'>()

function Root() {
  const [client] = useState(() =>
    createSuperLineClient(api, {
      transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
      role: 'user',
    }),
  )
  return <Provider client={client}><Room /></Provider>
}

function Room() {
  const { call: send, isLoading } = useRequest('send')
  const presence = useSubscription('presence')
  useEvent('message', (m) => append(m))
  // ...
}
```

`react >= 18` is a peer dependency. Every hook is narrowed to the role passed to `createSuperLineHooks<typeof api, 'user'>()`.

## `useCollection` & `useDoc` — persisted state

[Collections](https://super-line.dogar.biz/collections/) are typed, contract-declared state the server syncs. `useCollection` is a live, filtered **row-set**; `useDoc` opens a **CRDT document** by id whose concurrent edits merge. Both are typed from the contract — no shape to assert.

```tsx
import { eq } from '@super-line/core'

const { useCollection, useDoc } = createSuperLineHooks<typeof api, 'user'>()

// a live row-set — snapshot + per-row changes, filtered server-side
function Channel({ id }: { id: string }) {
  const { rows, insert } = useCollection('messages', { filter: eq('channelId', id) })
  return <ul>{rows.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
}

// a CRDT document — concurrent edits to different fields merge
function Board({ id }: { id: string }) {
  const { data, update } = useDoc('scenes', id)
  if (!data) return <p>Loading…</p> // undefined until the catch-up snapshot arrives
  return <input value={data.title} onChange={(e) => update({ title: e.target.value })} />
}
```

Row writes are non-optimistic — they appear once the server confirms them. For joins, live queries, and optimistic mutations, pair a collection with [TanStack DB](https://super-line.dogar.biz/collections/tanstack-db). See the [Collections guide](https://super-line.dogar.biz/collections/).

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [React](https://super-line.dogar.biz/how-to/react)
- 📕 API reference: <https://super-line.dogar.biz/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
