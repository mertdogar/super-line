# @super-line/react

React hooks for [**super-line**](https://mertdogar.github.io/super-line/), the strictly-typed realtime data bus — typed `useRequest` / `useEvent` / `useSubscription` / `useResource` bound to a contract + role.

```bash
pnpm add @super-line/react
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

## `useResource` — synced state

Open a [Store](https://mertdogar.github.io/super-line/guide/store) Resource and track it reactively. The handle is opened on mount and closed on unmount; writes go through `set` / `update` / `delete(path)`.

```tsx
const { useResource } = createSuperLineHooks<typeof api, 'user'>()

function Doc({ id }: { id: string }) {
  const { data, deleted, set, update, delete: del } = useResource<{ title: string; tags: string[] }>('docs', id)

  if (deleted) return <p>This doc was deleted.</p>
  if (!data) return <p>Loading…</p> // undefined until the catch-up snapshot arrives

  return (
    <input
      value={data.title}
      onChange={(e) => update({ title: e.target.value })}
    />
  )
  // del(['tags', 0]) removes a path; set(value) replaces the whole resource
}
```

`data` is `undefined` until the first snapshot lands, then mirrors the latest merged state. Stores are off-contract, so pass `T` to assert the shape. The `deleted` signal flips to `true` when the Resource is deleted anywhere in the cluster — a deletion fans out to every node, so each open handle observes it instead of silently reading an empty snapshot.

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [React](https://mertdogar.github.io/super-line/guide/react)
- 📕 API reference: <https://mertdogar.github.io/super-line/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
