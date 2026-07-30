# Use the React hooks

`@super-line/react` has one binding for the whole app. Declare your contract and role **once**, by declaration merging, and every module-level hook is typed by it — no factory call, no destructuring, no generic threading at call sites:

```ts
// superline.d.ts (any ambient .ts in your app source)
import type { chat } from './contract'

declare module '@super-line/react' {
  interface Register {
    contract: typeof chat
    role: 'user'
  }
}
```

```tsx
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { SuperLineProvider, useSuperLineClient } from '@super-line/react'

function Root() {
  // StrictMode-safe ownership: built in a committed effect, closed on unmount.
  const client = useSuperLineClient(() => createSuperLineClient(chat, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: 'user',
    params: { name: 'ada' },
  }), [])
  return (
    <SuperLineProvider client={client}>
      <Room room="lobby" />
    </SuperLineProvider>
  )
}
```

Skipping the registration is a **hard type error at the provider** (`__superLineRegisterMissing`), never a silent fall back to loose types. `Register` is one declaration per TypeScript program — an app declares it exactly once. (A package that ships code registering would leak the declaration to its consumers; keep it in a source-only ambient file the `.d.ts` build does not emit.)

Using [plugin-auth](/how-to/plugin-auth)? Mount `<SuperLineAuthProvider>` instead — it owns the session lifecycle *and* feeds this same context, so every hook below follows sign-in/sign-out with no wiring.

::: tip Own the client with `useSuperLineClient`
`createSuperLineClient` connects on construction and `close()` is terminal, so a client created during render (a `useState(() => …)` initializer) leaks a connected socket every time React double-invokes the render in dev. `useSuperLineClient(make, deps?)` builds in a committed effect, closes in its cleanup, and rebuilds when `deps` change — it returns `null` until the first commit, which is exactly the state every hook idles on. See [reconnection & delivery](/concepts/reconnection-delivery) for what survives a drop.
:::

## Call requests, read topics, handle events

```tsx
import { useEvent, useMaybeClient, useRequest, useSubscription } from '@super-line/react'

function Room({ room }: { room: string }) {
  // With an input, useRequest AUTO-FETCHES: on mount, when the input changes, and on a new session.
  const { data: joined, loading, refetch } = useRequest('join', { room })

  // Without an input it is purely manual — nothing fires until you call. This is the mutation form.
  const { call: send, loading: sending } = useRequest('send')

  // useSubscription: latest topic value (or undefined before the first message)
  const presence = useSubscription('presence')

  // useEvent: run a handler on each pushed event
  useEvent('message', (m) => append(m))

  const online = presence?.room === room ? presence.count : (joined?.count ?? 0)
  const onSubmit = (text: string) => send({ room, text }).catch(() => {})
  // ...
}
```

**Arity is the mode switch** for `useRequest`: supply an input argument and it auto-fetches (re-running when the input's JSON changes and when the client swaps), omit it and only `call(input)` ever fires. A request that takes no input opts into auto-fetching with an explicit `undefined` input; `{ enabled: false }` holds fire until you flip it (`enabled: !!channelId` covers "wait until known"). Auto-fetch fires exactly once per (client, input) even under StrictMode's double-mounting.

| Hook | Returns | Behavior |
| --- | --- | --- |
| `useRequest(method, input?, { enabled? })` | `{ data, error, loading, refetch, call }` | Auto-fetches when an input is supplied; `call(input)` is the manual path; `refetch()` re-runs with the hook's input (rejects in manual mode). Last call wins the rendered state. |
| `useSubscription(topic)` | latest value (`undefined` before the first message) | Subscribes on mount, re-renders on each new value, unsubscribes on unmount. |
| `useEvent(event, handler)` | — | Invokes `handler` for each pushed event; the latest handler is always used (no stale closures). |
| `useClient()` / `useMaybeClient()` | `SuperLineClient<C, R>` (throws with no client) / `… \| null` | The underlying client, for anything the hooks don't cover. |
| `useEnv()` | `EnvOf<C, R> \| null` | Tracks the connection's server-vended [`env`](/how-to/connection-env); `null` until the first push, then the latest value. |

For the wire patterns behind these — see [requests](/how-to/requests), [events & rooms](/how-to/events-rooms), and [topics](/how-to/topics).

## Track persisted state with collections

The contract's [collections](/collections/) get two reactive hooks. Both subscribe on mount, clean up on unmount, and expose `ready` — the difference between "the snapshot hasn't landed" and "genuinely empty".

**`useCollection(name, query?)`** tracks a live [row set](/collections/row-collections): the filtered snapshot re-renders as the server pushes matching inserts/updates/deletes, and `insert`/`update`/`delete`/`batch` write through. Pass `null` as the query for the explicit idle state (no subscription at all — distinct from `undefined`, which subscribes to the whole collection).

```tsx
function Channel({ id }: { id: string }) {
  const { rows, ready, insert } = useCollection('messages', { filter: eq('channelId', id) })
  if (!ready) return <Spinner />
  return (
    <>
      {rows.map((m) => <p key={m.id}>{m.text}</p>)}
      <button onClick={() => insert({ id: crypto.randomUUID(), channelId: id, text: 'hi' })}>send</button>
    </>
  )
}
```

The underlying surfaces stay reachable: `handle` (the client's `CollectionHandle`, stable per client+name — one-shot reads via `handle.query(q)`) and `sub` (the live `LiveRowSet`). They're windows, not ownership — the hook closes the subscription itself.

**`useDoc(name, id, deps?)`** opens a [CRDT document](/collections/crdt-documents) and tracks it reactively. The id can be a `string`, `null`/`undefined` (the idle state — nothing opens), or a **resolver** `() => id | Promise<id>` for ids that arrive asynchronously (a registry lookup, a request); the resolver re-runs when `deps` change, and an inline arrow is safe.

```tsx
function Doc({ id }: { id: string | null }) {
  const { data, ready, error, deleted, update, delete: del } = useDoc('scenes', id)
  if (error) return <p>Can't open this doc.</p>
  if (deleted) return <p>This doc was deleted.</p>
  if (!ready) return <p>Loading…</p>
  return <input value={data!.title} onChange={(e) => update({ title: e.target.value })} />
}
```

- **`ready`** flips true only after the catch-up snapshot has applied. A just-opened doc exposes a (possibly empty) *local* snapshot before that, so gate on `ready`, not on `data` — especially before binding an editor to `native` (an early binding writes real ops that merge with the arriving content).
- **`error`** carries a denied or absent open (`NOT_FOUND`, `FORBIDDEN`) and resolver failures — they used to be invisible.
- **`update(partial)`** merges a partial; **`delete(path)`** surgically removes the value at a key path — concurrent edits to sibling keys merge instead of clobbering.
- **`deleted`** flips to `true` once the server fans the document's deletion across the cluster.
- **`handle`** is the reactive `DocHandle` and **`native`** the CRDT engine's own document (narrow it with the engine's accessor, `yDocOf` for Yjs) — both identity-stable until the underlying document is replaced.

For client query joins and optimistic UI over collections, wire them into TanStack DB — see [the TanStack DB adapter](/collections/tanstack-db). For the raw `LiveRowSet` → React glue (a set you built yourself from the client surface), `useLiveQuery(make, deps)` is the context-free primitive `useCollection` itself is built on.

## Read the connection's env

**`useEnv()`** tracks the connection's server-vended, client-visible [`env`](/how-to/connection-env)
reactively: `null` until the first push (or for a role with no `env`), then the latest value — re-renders on
every server-side `setEnv`.

```tsx
function Toolbar() {
  const env = useEnv() // typed EnvOf<C, R>; null until the first push
  if (!env) return null
  return <span>project: {env.projectId}</span>
}
```

`env` carries credentials — wire it into effects/calls, never render a raw secret. See
[connection env](/how-to/connection-env) for declaring the shape, seeding it at connect, and rotating it live.

## StrictMode is supported

Every client-owning surface builds in a committed effect and pairs every build with exactly one close — `useSuperLineClient` for your own client, `<SuperLineAuthProvider>` for a session, plugin-chat's `<ChatProvider>` for its chat client. StrictMode's dev-mode double-invoke therefore opens and closes one extra, properly-paired connection and nothing leaks; the examples all run with StrictMode on.

## The factory escape hatch

`createSuperLineHooks<C, R>()` returns the same hooks bound to a private context — for the rare app that talks to **two contracts** (each factory instance is its own world), and for tests. Don't mix the two: hooks from a factory instance never see what the registered provider feeds, and vice versa. Pick one surface per app and use it end to end.

```tsx
const { Provider, useRequest, useCollection } = createSuperLineHooks<typeof chat, 'user'>()
```

Next: [Testing](/how-to/testing).
