<script setup>
import ReactIslandDemo from '../.vitepress/theme/components/demos/ReactIslandDemo.vue'
</script>

# Tutorial 3 · Make it React

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/connect-a-client">2 · Connect a typed client</a> → <strong>3 · Make it React</strong> → <a href="/tutorials/store-your-data">4 · Store your data</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
<strong><code>@super-line/react</code></strong> turns the wire into hooks: requests, events, and topics from Tutorial 2, plus <strong>live data</strong> that re-renders as rows change. You declare your contract <strong>once</strong> and every hook in the package is typed by it — no factory threading, no generics at call sites. And because this docs site can run super-line in the page, the demo below is <strong>two real React apps</strong>, not a recording.
</p>

<p class="sl-qs-meta">
  <span>~8 minutes</span>
  <span>Builds on Tutorial 2</span>
  <span>React 18+ · StrictMode-safe</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Register</b> <code>interface Register</code></span>
  <span class="sl-qs-pill"><b>Own</b> <code>useSuperLineClient</code></span>
  <span class="sl-qs-pill"><b>Live</b> <code>useCollection</code></span>
</p>

</div>

## First, see it run

Two **real `react-dom` roots** — each its own client connection, both on one in-tab server. Add a todo on either side, toggle the seed row — the other React app re-renders from the live subscription. The component source is further down this page, and it is the *same module* running here: imported, not transcribed.

<ReactIslandDemo />

## 1. Install

In a React project (Vite, Next, anything React 18+):

::: code-group

```bash [pnpm]
pnpm add @super-line/react @super-line/client @super-line/core @super-line/transport-websocket zod
```

```bash [npm]
npm install @super-line/react @super-line/client @super-line/core @super-line/transport-websocket zod
```

```bash [yarn]
yarn add @super-line/react @super-line/client @super-line/core @super-line/transport-websocket zod
```

:::

## 2. Register your contract — once

Declare the app's contract + role by **declaration merging**, one time, in any ambient file your app compiles (`superline.d.ts` is the convention). Every module-level hook (`useRequest`, `useEvent`, `useSubscription`, `useCollection`, `useDoc`, `useEnv`, `useClient`) is typed by it from then on — and skipping it is a hard type error at the provider, never a silent fall-back to loose types:

```ts
// superline.d.ts
import type { chat } from './contract' // Tutorial 1's contract

declare module '@super-line/react' {
  interface Register {
    contract: typeof chat
    role: 'user'
  }
}
```

::: tip One app, one contract
`Register` is a program-wide singleton — exactly one declaration per app. Multi-contract apps and tests use the `createSuperLineHooks<C, R>()` factory instead, which returns the same hooks bound to their own context.
:::

## 3. Own the client, provide it, use the hooks

Construction connects — so a client must be built in a **committed effect**, not during render, or React StrictMode's double-invoke leaks a socket. `useSuperLineClient` is that pattern, packaged; it returns `null` until the first commit, and `SuperLineProvider` accepts `null` (hooks idle instead of throwing).

```tsx [src/App.tsx]
import { useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import {
  SuperLineProvider,
  useSuperLineClient,
  useEvent,
  useSubscription,
  useRequest,
} from '@super-line/react'
import { chat } from './contract'

export function App() {
  const client = useSuperLineClient(
    () =>
      createSuperLineClient(chat, {
        transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
        role: 'user',
        params: { name: 'ada' },
      }),
    [], // deps — rebuild (reconnect) when these change
  )
  return (
    <SuperLineProvider client={client}>
      <Room />
    </SuperLineProvider>
  )
}

function Room() {
  const [log, setLog] = useState<string[]>([])
  useEvent('message', (m) => setLog((l) => [...l, `${m.from}: ${m.text}`])) // event → handler
  const presence = useSubscription('presence') // topic → latest value (undefined before the first push)
  const join = useRequest('join') // no input argument = manual mode: fire via call()
  const send = useRequest('send')

  return (
    <>
      <p>{presence ? `${presence.count} online in ${presence.room}` : 'no presence yet'}</p>
      <button onClick={() => join.call({ room: 'lobby' })}>join lobby</button>
      <button onClick={() => send.call({ room: 'lobby', text: 'hi from React' })} disabled={send.loading}>
        say hi
      </button>
      <ul>{log.map((line, i) => <li key={i}>{line}</li>)}</ul>
    </>
  )
}
```

Run Tutorial 1's server (`npm run server`) and this component talks to it — the same three patterns as Tutorial 2, now rendering.

::: tip `useRequest` has two modes, switched by arity
`useRequest('send')` is **manual** — nothing fires until you `call(input)`; that's your mutation shape. `useRequest('getProfile', { id })` — with an input argument — **auto-fetches** on mount, when the input changes, and when the client swaps, exposing `{ data, error, loading, refetch }`. One hook, TanStack-style, for both.
:::

## 4. The live data hook

The demo at the top isn't using `useEvent` — it's using **`useCollection`**, the hook over super-line's synced, typed row-sets. Here is the actual source it runs. First the contract — one new block, `collections`:

<<< @/.vitepress/theme/components/react/todos-contract.ts

Then the component — `TodoTab` is what's mounted twice above:

<<< @/.vitepress/theme/components/react/TodoTab.tsx

`useCollection('todos', query)` gives you `rows` (identity-stable, ordered), `ready` (snapshot applied — so "loading" and "genuinely empty" are distinguishable), `error`, and typed `insert` / `update` / `delete` / `batch` mutations. Every change any client writes lands in every subscribed component.

::: warning Where do those rows actually *live*?
On the server — validated against the schema, guarded by policies, persisted by a backend. You just used all of that without seeing it. Pulling that curtain back is exactly the next lesson.
:::

## What just happened

| What you wrote | What it does |
| --- | --- |
| `declare module … Register` | Types every module-level hook from your one contract. No factory, no generics at call sites. |
| `useSuperLineClient(make, deps)` | StrictMode-safe client ownership: built in a committed effect, closed on unmount, rebuilt on deps change. |
| `<SuperLineProvider client={…}>` | Feeds the one context every hook reads. `null` = "not connected yet" — hooks idle. |
| `useEvent` / `useSubscription` / `useRequest` | Tutorial 2's three wire patterns, as hooks. |
| `useCollection(name, query)` | A live, typed row-set with `ready`/`error` and typed mutations. |

## Next: the machinery under `useCollection`

Declare a collection, secure it with row-level policies, give the server a storage backend — and find out why the demo's rows can outlive the server that served them.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/store-your-data">Tutorial 4 · Store your data →</a></strong> — collections, policies, and swappable storage backends, with a kill-the-server-keep-the-data demo.</p>
</div>

### Or branch off from here

- [Use the React hooks](/how-to/react) — the full hook surface, including `useDoc`, `useEnv`, and the factory form.
- [Querying with TanStack DB](/collections/tanstack-db) — joins, live queries, and optimistic writes over the same sync source.
- [Debug a tab with DevTools](/how-to/devtools-panel) — watch these hooks' frames in the browser panel.
