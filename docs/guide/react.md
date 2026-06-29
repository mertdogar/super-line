# React

`@super-line/react` binds typed hooks to a contract + role. Create the hooks once, create the client once, wrap your tree in the `Provider`.

```tsx
import { useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createSuperLineHooks } from '@super-line/react'
import { chat } from './contract'

const { Provider, useClient, useRequest, useEvent, useSubscription } =
  createSuperLineHooks<typeof chat, 'user'>()

function Root() {
  // create the client once; it connects immediately and reconnects on its own
  const [client] = useState(() => createSuperLineClient(chat, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: 'user',
    params: { name: 'ada' },
  }))
  return (
    <Provider client={client}>
      <Room room="lobby" />
    </Provider>
  )
}
```

The role is a type argument to `createSuperLineHooks<typeof chat, 'user'>()`, so every hook is narrowed to that role's surface.

## The hooks

```tsx
function Room({ room }: { room: string }) {
  // useRequest: { data, error, isLoading, call }
  const { call: send, isLoading } = useRequest('send')

  // useSubscription: latest topic value (or undefined before the first message)
  const presence = useSubscription('presence')

  // useEvent: run a handler on each pushed event
  useEvent('message', (m) => append(m))

  // useClient: the raw client, if you need it
  const client = useClient()

  const onSubmit = (text: string) => send({ room, text }).catch(() => {})
  // ...
}
```

- **`useRequest(method)`** → `{ data, error, isLoading, call }`. `call(input)` performs the typed request and updates state; it also returns the promise.
- **`useSubscription(topic)`** → the latest value, re-rendering as new ones arrive. Subscribes on mount, unsubscribes on unmount.
- **`useEvent(event, handler)`** → invokes `handler` for each pushed event (the latest handler is always used; no stale closures).
- **`useClient()`** → the underlying `SuperLineClient<C, R>`.

## Synced state

For [Stores](./synced-state) (durable, off-contract resources), `useResource` opens a Resource and tracks it reactively. It returns `data` (untyped — pass `T` to assert the shape; `undefined` until the catch-up snapshot arrives), the `deleted` signal, and `set`/`update`/`delete` to write through. The handle is opened on mount and closed on unmount.

```tsx
function Doc({ id }: { id: string }) {
  const { data, deleted, set, update, delete: del } = useResource<{ title: string; tags: string[] }>('docs', id)

  if (deleted) return <p>This doc was deleted.</p>
  if (!data) return <p>Loading…</p>

  return (
    <>
      <input value={data.title} onChange={(e) => update({ title: e.target.value })} />
      <button onClick={() => del(['tags', 0])}>drop first tag</button>
    </>
  )
}
```

- **`set(value)`** replaces the whole document; **`update(partial)`** merges a partial; **`delete(path)`** surgically removes the value at a key path. All three write the local replica and send the Change to the server.
- **`deleted`** flips to `true` once the server fans the Resource's deletion out across the cluster (an `SDeleteFrame` reaches this node), and the component re-renders. This is the cross-node deletion signal: a Resource deleted on any node — or directly on the server via `ServerStore.onDelete`/`delete` — turns `deleted` true everywhere. Until then a deleted Resource would read as a silent empty snapshot, so branch on `deleted` to tell "deleted" apart from "still loading".

## StrictMode

In development, React StrictMode double-invokes effects, which would open/close the live socket twice. The [react-chat example](https://github.com/mertdogar/super-line/tree/main/examples/react-chat) omits StrictMode for that reason; add it back once you guard the client lifecycle (e.g. a ref-counted singleton).

Next: [Testing](./testing).
