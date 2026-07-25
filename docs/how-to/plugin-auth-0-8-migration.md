# Migrate to plugin-auth 0.8 (React)

`@super-line/plugin-auth` 0.8 and `@super-line/react` 0.11 collapse the two React bindings into one and add
a generic way to change identity without remounting your app.

Two things drove it. First, super-line freezes a connection's role **and** its credential at connect, so every
identity change is a *session replacement* — but the only triggers were boot, `signIn` and `signOut`. An app
whose credential comes from somewhere else (a sealed token minted per account, say) had no way to switch
accounts except to rebuild the whole binding and remount the tree. Second, the library shipped two React
bindings that didn't compose: `createSuperLineHooks` needed a client fed in and threw without one, while
`createAuth` *owned* the client and swapped it — so every authenticated app hand-wrote the bridge between
them, and some ended up reimplementing library hooks to work around it.

## What changed

| 0.7 | 0.8 |
| --- | --- |
| `createAuth(opts)` → `{ AuthProvider, useAuth, auth }` | `<SuperLineAuthProvider>` + module-level hooks, typed by `Register` |
| `createSuperLineHooks()` + hand-written bridge | the same hooks, re-exported from `plugin-auth/react`, fed automatically |
| `useAuth()` → a fresh `{ client, state, ready, … }` per render | `useAuth()` → the **`AuthClient` instance** (stable, live getters) |
| `useAuth().ready: boolean` | `state.pending` (covers boot *and* later switches) |
| `AuthState { status, error?, … }` | `AuthState { status, pending, error, … }` — `error` no longer optional |
| account switch = rebuild the binding, remount the tree | `auth.reauthenticate()` |
| `<Provider client={c}>` required a non-null client | accepts `client: T \| null`; hooks idle |
| a write with no live subscription silently resolved | it **rejects** `UNAUTHORIZED` |

`authClient()` from `@super-line/plugin-auth/client` is unchanged in shape and is still the non-React entry.
`createSuperLineHooks` from `@super-line/react` still exists with the same public contract — if you don't use
plugin-auth, nothing here affects you.

## 1 · Declare `Register` once

The hooks are module-level, so they learn your contract by declaration merging instead of a factory generic.

```ts
// src/superline.d.ts
import type { contract } from '@omma/designer-contract'

declare module '@super-line/plugin-auth/react' {
  interface Register {
    contract: typeof contract
    role: 'user'
  }
}
```

Forget it and the provider fails to typecheck with `__superLineRegisterMissing` — deliberately, at the one
place every app touches, rather than leaving cryptic `never`s at each hook.

::: warning If you ship a package, not an app
`declare module` is a **global** augmentation. If it lands in your published `.d.ts`, every consumer inherits
your contract — and one with its own can't override it, because conflicting interface members are a hard
error, not a shadow. Keep the declaration in a source-only ambient file your dts build does not emit, and
check the emitted output once to confirm it isn't there.
:::

## 2 · Replace the binding with one provider

```tsx
// before
const { AuthProvider, useAuth } = createAuth<Contract, 'user'>({ authedRole: 'user', tokenParam: 'jwt', resolveToken, connect })
const { Provider, useClient } = createSuperLineHooks<Contract, 'user'>()

function Bridge({ children }) {
  const { client, state } = useAuth()
  if (state.status !== 'authed') return <Splash />
  return <Provider client={client}>{children}</Provider>
}
<AuthProvider><Bridge>{app}</Bridge></AuthProvider>

// after
<SuperLineAuthProvider authedRole="user" tokenParam="jwt" resolveToken={resolveToken} connect={connect}>
  {app}
</SuperLineAuthProvider>
```

Then import hooks directly wherever you need them — no client threaded through props, no re-export hub:

```ts
import {
  useAuth, useClient, useCollection, useDoc, useEvent, useSubscription, useRequest, useEnv,
} from '@super-line/plugin-auth/react'
```

**Options are captured at mount.** Changing `resolveToken`/`connect` on a mounted provider does not rebuild the
session — an inline arrow would otherwise tear the socket down on every render. To change identity, use
`reauthenticate()` (step 4).

If non-React code drives the same session (a CLI, a test script), build the instance yourself and let the
provider **adopt** it. The provider never closes an instance it did not build:

```tsx
export const auth = authClient<typeof contract, 'user'>({ authedRole: 'user', connect })
<SuperLineAuthProvider client={auth}>{app}</SuperLineAuthProvider>
```

Nesting a second provider gives a second, independent session — that is how one app runs two.

## 3 · Fix the gate order

This is the change most likely to bite you. **Test `status === 'authed'` before `pending`.**

```tsx
// before
if (!ready) return <Splash />
if (state.status !== 'authed') return <Login />
return <Workspace client={client} />

// after
if (state.status === 'authed') return <Workspace />   // ← first
if (state.pending) return <Splash />
return <Login />
```

During a session replacement the incumbent stays live and `pending` goes true, so `status` still says
`authed`. Checking `pending` first would unmount your workspace on every switch — the exact re-boot this
release exists to remove.

## 4 · Switch accounts with `reauthenticate()`

```tsx
// before — a new binding per account, keyed to force a remount
const authSignature = `${apiKey}|${accountSlug}|${apiBaseUrl}`
<AuthedSession key={authSignature}>{children}</AuthedSession>   // the whole editor re-boots

// after
const auth = useAuth()
await switchUpstreamAccount(next)
await auth.reauthenticate()
```

`resolveToken` is your **credential source**, not a boot hook: boot is merely its first consultation and each
`reauthenticate()` is another. If your resolver already reads credentials fresh per call — an imperative tRPC
caller whose headers come from a store, for instance — it needs **no change at all**; it will mint for the new
account on the next consultation.

`reauthenticate()` resolves with the settled state and **never destroys a session it could not replace**:

| the source | result |
| --- | --- |
| yields a credential the server accepts | replaced; `error` cleared |
| throws, or yields one the server refuses | **current session kept**, `error` set |
| returns `null` | dropped to guest (a deliberate "no credential"; no server-side revoke — that's `signOut`) |

So a mint route returning 500 costs the user nothing. It throws only on misuse — starting a transition while
one is in flight.

With no `resolveToken` (a password app) it re-consults `storage` instead, which makes it a *revalidate*:
reconnect with the persisted token, confirm, and drop to guest if it has been revoked.

## 5 · Delete what the library now owns

Everything below has a first-party replacement. Check your codebase for each:

| Delete | Replacement |
| --- | --- |
| a hand-rolled `useSuperLineEvent` (handler-ref trick) | `useEvent` |
| `whenClientReady()` passing through to `binding.auth.ready` | `useAuth().ready` |
| `const client = state.status === 'authed' ? live : null` | `useClient()` — already null until authed |
| `useEffect(() => () => binding.auth.client.close(), [binding])` | the provider closes what it built |
| a keyed `<AuthedSession>` wrapper | `reauthenticate()` |
| a `lib/superline.ts` hooks hub | import from `plugin-auth/react` |

## 6 · Reads idle, writes shout

Before there is a session, the data hooks go idle: `useCollection(...).rows` is `[]`, `useDoc(...).data` is
`undefined`, `useEvent` never binds. **Writes do not**: `insert`/`update`/`delete` reject `UNAUTHORIZED` and
`useDoc`'s `set`/`update`/`delete` throw.

That is deliberate. A silently-resolved write is indistinguishable from a landed one, so the old behavior lost
data with no signal. If you have a component that writes on mount, gate it on `status === 'authed'` or handle
the rejection.

## Best practices

**Use `useAuth()` as a dependency, not a snapshot.** It returns the *instance*, whose `.state`/`.client` are
live getters. That gives you one object that is both stable and current:

```tsx
const auth = useAuth()
const provider = useMemo(() => async (id: string) => {
  await auth.ready
  if (auth.state.status !== 'authed') return null   // read at CALL time, not render time
  return openWith(auth.client)
}, [auth])                                          // stable — this memo never churns
```

Reading `auth.state` inside an async callback sees the truth at that moment. Destructured values
(`const { state } = useAuth()`) are frozen at that render, which is what you want in JSX and not what you want
in a promise chain.

**Don't gate rendering on `ready`.** It is a boot-only, one-shot promise whose identity never changes — good
for `await`, useless for describing a later switch. Use `state.pending`.

**One transition at a time.** `signIn`, `signUp`, `signOut` and `reauthenticate` all throw `CONFLICT` while
another is in flight. Disable the submit button on `state.pending` — which also closes a real bug: a slow boot
resolver used to land *after* an interactive sign-in and silently overwrite it.

**Let `useClient()` be null.** It is null exactly while there is no confirmed session. Inside a subtree you
only render when authed, `useClient()!` is honest; anywhere else, handle the null rather than asserting.

## Verify

- [ ] `Register` declared, and **not** in your published `.d.ts` if you ship a package
- [ ] every `state.status !== 'authed'` gate re-ordered to check `authed` first
- [ ] no `createAuth`, no bridge component, no hooks hub left
- [ ] switching accounts keeps the workspace mounted — component state survives
- [ ] a deliberately failing mint leaves you signed in with `state.error` set
- [ ] any write issued before auth surfaces an error instead of vanishing

## See also

- [Add authentication (plugin)](/how-to/plugin-auth) — the full wiring
- [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens) — `resolveToken` + `tokenParam` for a sealed-only app
- [The auth lifecycle](/concepts/auth-lifecycle-sealed-tokens) — why identity change is a reconnect
