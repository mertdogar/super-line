# Use the React hooks

`@super-line/react` binds typed hooks to a contract + role. Do it once: create the hooks, create the client, wrap your tree in the `Provider`. Every hook is then narrowed to that role's surface, with no per-call type annotations.

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

The role is a type argument to `createSuperLineHooks<typeof chat, 'user'>()` — pass the same role you connect with, and the returned hooks only expose that role's requests, events, and topics.

::: tip Create the client once
Wrap `createSuperLineClient` in `useState(() => …)` (or a module singleton) so it is constructed a single time. The client connects on construction and reconnects on its own — re-creating it on every render would tear down and rebuild the socket. See [reconnection & delivery](/concepts/reconnection-delivery) for what survives a drop.
:::

## Call requests, read topics, handle events

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

| Hook | Returns | Behavior |
| --- | --- | --- |
| `useRequest(method)` | `{ data, error, isLoading, call }` | `call(input)` performs the typed request, updates state, and also returns the promise. |
| `useSubscription(topic)` | latest value (`undefined` before the first message) | Subscribes on mount, re-renders on each new value, unsubscribes on unmount. |
| `useEvent(event, handler)` | — | Invokes `handler` for each pushed event; the latest handler is always used (no stale closures). |
| `useClient()` | `SuperLineClient<C, R>` | The underlying client, for anything the hooks don't cover. |

For the wire patterns behind these — see [requests](/how-to/requests), [events & rooms](/how-to/events-rooms), and [topics](/how-to/topics).

## Track persisted state with collections

The contract's [collections](/collections/) get two reactive hooks. Both subscribe on mount and clean up on unmount.

**`useCollection(name, query)`** tracks a live [row set](/collections/row-collections): the filtered snapshot re-renders as the server pushes matching inserts/updates/deletes, and `insert`/`update`/`delete`/`batch` write through.

```tsx
function Channel({ id }: { id: string }) {
  const { rows, insert } = useCollection('messages', { filter: eq('channelId', id) })
  return (
    <>
      {rows.map((m) => <p key={m.id}>{m.text}</p>)}
      <button onClick={() => insert({ id: crypto.randomUUID(), channelId: id, text: 'hi' })}>send</button>
    </>
  )
}
```

**`useDoc(name, id)`** opens a [CRDT document](/collections/crdt-documents) by id and tracks it reactively — `data` (`undefined` until the catch-up snapshot arrives), the `deleted` signal, and `update`/`delete` to write through (edits merge).

```tsx
function Doc({ id }: { id: string }) {
  const { data, deleted, update, delete: del } = useDoc('scenes', id)
  if (deleted) return <p>This doc was deleted.</p>
  if (!data) return <p>Loading…</p>
  return <input value={data.title} onChange={(e) => update({ title: e.target.value })} />
}
```

- **`update(partial)`** merges a partial; **`delete(path)`** surgically removes the value at a key path — concurrent edits to sibling keys merge instead of clobbering.
- **`deleted`** flips to `true` once the server fans the document's deletion across the cluster (a `cddel` reaches this node). Until then a deleted doc reads as a silent empty snapshot, so branch on `deleted` to tell "deleted" apart from "still loading".

For client query joins and optimistic UI over collections, wire them into TanStack DB — see [the TanStack DB adapter](/collections/tanstack-db).

## Guard StrictMode

In development, React StrictMode double-invokes effects, which would open/close the live socket twice. The [react-chat example](https://github.com/mertdogar/super-line/tree/main/examples/react-chat) omits StrictMode for that reason; add it back once you guard the client lifecycle (e.g. a ref-counted singleton).

Next: [Testing](/how-to/testing).
