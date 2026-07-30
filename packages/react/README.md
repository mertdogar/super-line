# @super-line/react

React hooks for [**super-line**](https://super-line.dogar.biz/), the strictly-typed realtime data bus — one registered binding per app: declare your contract + role once, and every module-level hook (`useRequest` / `useEvent` / `useSubscription` / `useCollection` / `useDoc`) is typed by it.

```bash
pnpm add @super-line/core @super-line/client @super-line/react
```

```ts
// superline.d.ts — the ONE declaration (per TypeScript program)
import type { api } from './contract'

declare module '@super-line/react' {
  interface Register { contract: typeof api; role: 'user' }
}
```

```tsx
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { SuperLineProvider, useSuperLineClient, useRequest, useSubscription, useEvent } from '@super-line/react'
import { api } from './contract'

function Root() {
  // StrictMode-safe ownership: built in a committed effect, closed on unmount.
  const client = useSuperLineClient(() =>
    createSuperLineClient(api, {
      transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
      role: 'user',
    }), [])
  return <SuperLineProvider client={client}><Room room="lobby" /></SuperLineProvider>
}

function Room({ room }: { room: string }) {
  const { data: joined, loading } = useRequest('join', { room }) // an input ⇒ AUTO-FETCHES (and refetches on change)
  const { call: send } = useRequest('send')                      // no input ⇒ manual: nothing fires until you call
  const presence = useSubscription('presence')
  useEvent('message', (m) => append(m))
  // ...
}
```

`react >= 18` is a peer dependency. Skipping the registration is a hard type error at the provider. Using [plugin-auth](https://super-line.dogar.biz/how-to/plugin-auth)? Mount `<SuperLineAuthProvider>` instead — it feeds this same binding. For a multi-contract app or a test, `createSuperLineHooks<typeof api, 'user'>()` returns the same hooks bound to a private context.

## `useCollection` & `useDoc` — persisted state

[Collections](https://super-line.dogar.biz/collections/) are typed, contract-declared state the server syncs. `useCollection` is a live, filtered **row-set**; `useDoc` opens a **CRDT document** whose concurrent edits merge. Both expose `ready` — "snapshot not landed yet" vs "genuinely empty" — plus their underlying handles.

```tsx
import { eq } from '@super-line/core'
import { useCollection, useDoc } from '@super-line/react'

// a live row-set — snapshot + per-row changes, filtered server-side
function Channel({ id }: { id: string }) {
  const { rows, ready, insert, batch } = useCollection('messages', { filter: eq('channelId', id) })
  if (!ready) return <Spinner />
  return <ul>{rows.map((m) => <li key={m.id}>{m.text}</li>)}</ul>
}

// a CRDT document — the id may be a string, null (idle), or an async resolver
function Board({ id }: { id: string | null }) {
  const { data, ready, error, update } = useDoc('scenes', id)
  if (error) return <p>Can't open this board.</p>
  if (!ready) return <p>Loading…</p> // gate on ready, not on data — pre-ready data is a local snapshot
  return <input value={data!.title} onChange={(e) => update({ title: e.target.value })} />
}
```

Row writes are non-optimistic — they appear once the server confirms them. For joins, live queries, and optimistic mutations, pair a collection with [TanStack DB](https://super-line.dogar.biz/collections/tanstack-db). See the [Collections guide](https://super-line.dogar.biz/collections/).

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [React](https://super-line.dogar.biz/how-to/react) · [Migrate to the one binding](https://super-line.dogar.biz/how-to/react-one-binding-migration)
- 📕 API reference: <https://super-line.dogar.biz/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
