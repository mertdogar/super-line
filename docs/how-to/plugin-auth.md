# Authentication — `@super-line/plugin-auth`

Proper authentication as a **paired plugin**: email/password sign-up + login, reusable **access tokens**, connection **sessions**,
data-driven **roles**, **API keys**, and **JWT** — with all identity held in typed [collections](/collections/).
It builds on super-line's connect-time [`authenticate`](/how-to/roles-auth) model; you wire it in three places
and the plugin owns the rest.

```bash
pnpm add @super-line/core @super-line/plugin-auth
```

Not sure you need the plugin over a hand-rolled `authenticate`? See [Choose an auth strategy](/how-to/choose-an-auth-strategy). New to it? Walk the [Add auth to your app](/tutorials/add-auth-to-your-app) tutorial first.

## Wire it in

### 1 · Contract

`authContract()` is the contract-time half — merged into your contract, it adds the `guest` role, the
auth collections, and the `signIn`/`signUp`/`signOut`/`whoami` surface. Because
it merges into the one contract, `RowOf`, `client.collection`, and per-role `Requests` all keep working end-to-end.

```ts
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'

export const app = defineContract({
  roles: { user: {}, admin: { /* … */ } }, // your app roles — do NOT declare `guest`, auth adds it
  collections: { /* your app collections */ },
  plugins: [authContract()],
})
```

Auth owns identity: don't declare your own `guest` role or `users` collection (a collision throws at `defineContract`).
Reference the directory from your rows with `references: { authorId: 'users' }`.

### 2 · Server

Hand the auth kit the **same** `CollectionStore` the server uses, then wire `authenticate` + `identify` at the top
level and register the plugin. `signIn`/`signUp`/`signOut`/`whoami` are handled by the plugin — subtracted from your
`implement()`.

```ts
import { createSuperLineServer } from '@super-line/server'
import { auth } from '@super-line/plugin-auth/server'

const backend = sqliteCollections({ file: 'app.db', collections: app.collections })
const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })

createSuperLineServer(app, {
  nodeKey: 'app-replica-1', // stable for this replica across restarts
  collections: backend,
  authenticate: authKit.authenticate, // verifies a credential and creates a connection session
  identify: authKit.identify, // principal := userId, so every row policy keys on the logged-in user
  plugins: [authKit.plugin], // handlers + open/deny-all row policies
})
```

A stable `nodeKey` is required — the plugin keys per-node session reconciliation on it, and a changing value leaks prior-boot sessions.

### 3 · Client (React)

`<SuperLineAuthProvider>` owns the guest↔authed lifecycle **and** feeds the live client to every hook, so there is
no bridge to write. Type the hooks once by declaring `Register`:

```ts
// superline.d.ts — one declaration, and every hook below is typed by your contract
import type { app } from './contract'

declare module '@super-line/plugin-auth/react' {
  interface Register {
    contract: typeof app
    role: 'user'
  }
}
```

```tsx
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { SuperLineAuthProvider } from '@super-line/plugin-auth/react'

const connect = ({ role, params }) =>
  createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: role as 'user', params })

createRoot(el).render(
  <SuperLineAuthProvider authedRole="user" connect={connect}>
    <App />
  </SuperLineAuthProvider>,
)
```

```tsx
import { useAuth, useCollection } from '@super-line/plugin-auth/react'

function App() {
  const { state, signIn, signUp, signOut } = useAuth()
  // Authed FIRST: a re-authentication keeps the current session live with `pending` set, so testing
  // `pending` first would tear the app down mid-switch.
  if (state.status === 'authed') return <Workspace me={state.userId} name={state.displayName} onSignOut={signOut} />
  if (state.pending) return <Splash />
  return <LoginForm onSignIn={signIn} onSignUp={signUp} />
}
```

Every data hook comes from the same import and needs no client passed in — `useClient` (`null` until
authenticated), `useCollection`, `useDoc`, `useEvent`, `useSubscription`, `useRequest`, `useEnv`. Before there is a
session they go **idle**: reads return empty, writes reject `UNAUTHORIZED` rather than silently succeeding.

Already own an `authClient()` instance (a script driving the same session, say)? Hand it over instead:
`<SuperLineAuthProvider client={auth}>`. The provider never closes an instance it did not build. Nesting a second
provider gives a second independent session — that is how one app runs two.

Not using React? `authClient()` from `@super-line/plugin-auth/client` is the same logic, framework-agnostic.

### Switching accounts

`reauthenticate()` re-consults your credential source and replaces the session in place — no remount, no lost
component state:

```tsx
const auth = useAuth()
await switchUpstreamAccount(next)
await auth.reauthenticate()
```

It **never destroys a session it could not replace**: the new connection is confirmed before the old one closes, so
a failed mint leaves you signed in with `state.error` set. Only a `null` from the source drops you to guest.

## How login works over the bus

super-line freezes a connection's role at connect, so there's no "log in and upgrade this socket." The client half
hides the dance: `signIn()` connects as `guest`, mints an access token, then transparently **reconnects** as your
`authedRole` carrying the token — and persists it across reloads.

## Row security

The plugin ships policies for its own collections — `users` is a public directory (readable), while
`credentials`/`accessTokens`/`sessions`/`apiKeys` are server-only (deny-all). Your collections key their policies on the
`principal`, which is now the logged-in `userId`:

```ts
policies: {
  notes: { read: (principal) => eq('ownerId', principal) }, // you only read your own
}
```

See [Policies](/collections/policies) for the full row-security model.

## Go deeper

The plugin's full surface is split across focused guides:

- [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys) — durable sessions, roles-as-data, and `slp_` API keys.
- [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens) — server-minted bearer assertions for stateless and cross-service connect, including the sealed-only client (`resolveToken`/`tokenParam`).
- [Server-side hooks](/how-to/auth-hooks) — before/after connection admission, provisioning policy, and audit (ADR-0017).
- [Provision an agent identity](/how-to/auth-agent-identity) — run an AI agent as an API-key user, plus the `authKit` management surface and revocation.
- [Reset a password](/how-to/auth-password-reset) — the logged-out recovery flow via a host callback.

For the model — the connection lifecycle and why sealed tokens are server-minted — see [the auth lifecycle](/concepts/auth-lifecycle-sealed-tokens).

## Examples

- **`examples/auth`** — a runnable CLI walkthrough of the whole flow.
- **`examples/collections-chat`** — a Slack-like app with real login, on top of collections.

Next: [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys) · back to [Choose an auth strategy](/how-to/choose-an-auth-strategy).
