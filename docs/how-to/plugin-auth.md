# Authentication — `@super-line/plugin-auth`

Proper authentication as a **paired plugin**: email/password sign-up + login, reusable **access tokens**, connection **sessions**,
data-driven **roles**, **API keys**, and **JWT** — with all identity held in typed [collections](/collections/).
It builds on super-line's connect-time [`authenticate`](/how-to/roles-auth) model; you wire it in three places
and the plugin owns the rest.

```bash
pnpm add @super-line/plugin-auth
```

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

### 3 · Client (React)

`createAuth()` wraps the guest↔authed lifecycle behind an `<AuthProvider>` + a `useAuth()` hook.

```tsx
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createAuth } from '@super-line/plugin-auth/react'

export const { AuthProvider, useAuth } = createAuth({
  authedRole: 'user',
  connect: ({ role, params }) =>
    createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: role as 'user', params }),
})
```

```tsx
function App() {
  const { ready, state, client, signIn, signUp, signOut } = useAuth()
  if (!ready) return <Splash />
  if (state.status !== 'authed') return <LoginForm onSignIn={signIn} onSignUp={signUp} />
  return <Workspace client={client} me={state.userId} name={state.displayName} onSignOut={signOut} />
}
```

Not using React? `authClient()` from `@super-line/plugin-auth/client` is the same logic, framework-agnostic.

## How login works over the bus

super-line freezes a connection's role at connect, so there's no "log in and upgrade this socket." The client half
hides the dance: `signIn()` connects as `guest`, mints an access token, then transparently **reconnects** as your
`authedRole` carrying the token — and persists it across reloads.

## Roles are data

A user's `roles[]` live on their row. The client declares which role it wants; `authenticate` validates it's granted
(`guest` is the only hardcoded role). Grant a role by writing the user row:

```ts
await srv.collection('users').update({ ...user, roles: ['user', 'admin'] })
```

## Row security

The plugin ships policies for its own collections — `users` is a public directory (readable), while
`credentials`/`accessTokens`/`sessions`/`apiKeys` are server-only (deny-all). `userPresence` follows the
`usersReadable` policy. Your collections key their policies on the
`principal`, which is now the logged-in `userId`:

```ts
policies: {
  notes: { read: (principal) => eq('ownerId', principal) }, // you only read your own
}
```

See [Policies](/collections/policies) for the full row-security model.

## API keys

Long-lived credentials with one fixed role, for services and CI:

```ts
const { key } = await client.createApiKey({ label: 'ci', role: 'user' }) // the raw key is returned ONCE
// a service connects with it and receives a normal connection session:
createSuperLineClient(app, { role: 'user', params: { apiKey: key } })
```

`listApiKeys()` and `revokeApiKey({ id })` manage them.

## JWT

Enable `jwt: { secret }` on `auth(...)`. `getToken()` then issues a short-lived HS256 JWT — for another backend to
verify statelessly, or to connect super-line without a DB round-trip via `params: { jwt }`.

## Revocation

`authKit.revoke(userId)` revokes a user's access tokens, ends their active sessions, and disconnects their live
connections cluster-wide. This supports an admin ban or "sign out of all devices."

## Password reset

Provide a `sendPasswordReset({ user, token })` callback (email/SMS is yours to deliver). `requestPasswordReset` returns
a constant response — it never reveals whether an email exists — and `confirmPasswordReset` resets the password and
revokes existing access tokens and ends their active sessions.

## Server-side management (`authKit`)

Beyond the three wiring members (`authenticate` / `identify` / `plugin`) and `revoke(userId)`, the kit
exposes imperative surfaces for back-office code and provisioning — including AI-agent users. They need the
running server (the co-writer binds at plugin setup):

```ts
// authKit.users — the directory, back-office edits, and provisioning
authKit.users.get(id)                                         // → AuthUser | undefined
authKit.users.find({ filter?, limit?, offset?, includeDeactivated? }) // → AuthUser[] (active-only by default)
authKit.users.create({ displayName, roles?, metadata? })
authKit.users.update(id, { displayName?, metadata? })
authKit.users.setRoles(id, roles)                             // validated against contract roles (connect-time)
authKit.users.deactivate(id)   // soft-delete: stamp deletedAt, flush sessions/keys/resets, kick connections
authKit.users.reactivate(id)   // lift the deactivation
// authKit.credentials — attach email/password authentication only when needed
authKit.credentials.create(userId, { email, password? })     // omit password → invite flow
authKit.credentials.setPassword(userId, newPassword)         // rotation; revokes access + reset tokens

// authKit.apiKeys — provision agents & services
authKit.apiKeys.create(userId, { role, label, expiresInMs? }) // → { …info, key } — raw slp_… returned ONCE
authKit.apiKeys.listFor(userId)                              // → ApiKeyInfo[]
authKit.apiKeys.revoke(id)
```

Users **soft-delete** rather than vanish (`deactivate` / `reactivate`), so old rows keep rendering author
names; the `credentials` row stays (the email is reserved) and all three auth paths degrade to guest.

## Examples

- **`examples/auth`** — a runnable CLI walkthrough of the whole flow.
- **`examples/collections-chat`** — a Slack-like app with real login, on top of collections.
