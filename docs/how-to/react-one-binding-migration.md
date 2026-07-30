# Migrate to the one React binding

The React surface moved: `Register` and every data hook now live in `@super-line/react`, `plugin-auth/react` shrank to the session owner (`SuperLineAuthProvider` + `useAuth`), plugin-chat gained a registered module-level binding with an auto-building `ChatProvider`, and `useRequest` became the one TanStack-style request hook. The migration is mechanical; this page is the whole of it.

## 1 · Move the `Register` declaration

Same body, new module:

```diff
-declare module '@super-line/plugin-auth/react' {
+declare module '@super-line/react' {
   interface Register {
     contract: typeof app
     role: 'user'
   }
 }
```

## 2 · Move the data-hook imports

`useAuth` and `SuperLineAuthProvider` stay where they are; everything else comes from `@super-line/react`:

```diff
-import { useCollection, useDoc, useEvent, useSubscription, useRequest, useEnv, useClient } from '@super-line/plugin-auth/react'
+import { useCollection, useDoc, useEvent, useSubscription, useRequest, useEnv, useMaybeClient } from '@super-line/react'
 import { SuperLineAuthProvider, useAuth } from '@super-line/plugin-auth/react'
```

::: warning `useClient` changed meaning
plugin-auth's old `useClient` was the **null-returning** accessor. In `@super-line/react`, `useClient()` **throws** while there is no client — the null-returning one is `useMaybeClient()`. Rename old `useClient` call sites to `useMaybeClient`.
:::

## 3 · `useRequest`: `isLoading` → `loading`, and inputs auto-fetch

```diff
-const { call: join, isLoading } = useRequest('join')
-useEffect(() => { join({ room }).then(seed).catch(() => {}) }, [join, room])
+const { data: joined, loading } = useRequest('join', { room })   // auto-fetches; refetches when room changes
```

Existing one-argument call sites keep their manual behavior — nothing auto-fires without an input argument. A no-input request opts into auto-fetching with an explicit `undefined` input; `{ enabled: false }` holds fire. `refetch()` re-runs with the hook's input.

## 4 · Chat apps: delete the chatClient bridge

```diff
-const chat = useMemo(() => chatClient(client, { userId: me }), [client, me])
-useEffect(() => () => chat.close(), [chat])
-return <ChatProvider chat={chat}>…</ChatProvider>
+return <ChatProvider>…</ChatProvider>
```

Import the chat hooks module-level from `@super-line/plugin-chat/react` instead of a local `createChatHooks` file. The module-level `useChat()` returns `ChatClient | null` (the factory's throwing form is unchanged) — panes that only mount inside the authed subtree can keep a four-line throwing wrapper if they prefer the old ergonomics.

## 5 · What you get for it

- `useDoc` takes lazy ids (`string | null | resolver`) and exposes `ready`, `error`, and `handle` — a denied or absent open is finally visible, and editors sequence on `ready` instead of guessing from `native`.
- `useCollection` exposes `ready`, `batch`, `handle`, and `sub`, and takes `query: null` as the explicit idle state.
- One-shot reads: `client.collection(name).query(q)` resolves the ordered, limited snapshot and leaves no subscription behind.
- `useLiveQuery(make, deps)` is the exported low-level `LiveRowSet` → React glue you used to hand-write.
- `useSuperLineClient(make, deps?)` owns a client StrictMode-safely — and StrictMode is now supported across the whole binding, providers included.

The factory (`createSuperLineHooks`, `createChatHooks`) survives unchanged for multi-contract apps and tests.
