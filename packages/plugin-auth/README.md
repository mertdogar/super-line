# @super-line/plugin-auth

First-party **authentication** for [**super-line**](https://super-line.dogar.biz/), as a paired plugin:
email/password sign-up + login, server-issued **sessions**, data-driven **roles**, **API keys**, and
**JWT** — with all identity held in typed [collections](https://super-line.dogar.biz/collections/). It
builds on super-line's connect-time [`authenticate`](https://super-line.dogar.biz/how-to/roles-auth)
model; you wire it in three places and the plugin owns the rest.

```bash
pnpm add @super-line/plugin-auth
```

## Wire it in — three touch-points

```ts
// 1 · contract — authContract() adds the `guest` role, the users/credentials/sessions/apiKeys
//     collections, and the signIn/signUp/signOut/whoami (+ API-key, JWT, reset) requests.
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'

export const app = defineContract({
  roles: { user: {}, admin: {} },   // your roles — do NOT declare `guest`; auth adds it
  plugins: [authContract()],
})
```

```ts
// 2 · server — hand the kit the SAME CollectionStore the server uses, then wire it up.
import { createSuperLineServer } from '@super-line/server'
import { auth } from '@super-line/plugin-auth/server'

const backend = sqliteCollections({ file: 'app.db' })
const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })

createSuperLineServer(app, {
  collections: backend,
  authenticate: authKit.authenticate, // verifies the session token → { role, ctx: { userId, roles, sessionId } }
  identify: authKit.identify,         // principal := userId, so every row policy keys on the logged-in user
  plugins: [authKit.plugin],          // signIn/up/out/whoami handlers + open/deny-all row policies
})
```

```tsx
// 3 · client (React) — createAuth() wraps the guest↔authed lifecycle behind a provider + hook.
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createAuth } from '@super-line/plugin-auth/react'

export const { AuthProvider, useAuth } = createAuth({
  authedRole: 'user',
  connect: ({ role, params }) =>
    createSuperLineClient(app, { transport: webSocketClientTransport({ url }), role: role as 'user', params }),
})

// const { ready, state, client, signIn, signUp, signOut } = useAuth()
```

Not using React? `authClient()` from `@super-line/plugin-auth/client` is the same logic, framework-agnostic.

## Login is a reconnect, not an upgrade

super-line freezes a connection's role at connect, so there is no "log in and upgrade this socket." The
client half hides the dance: `signIn()` connects as `guest`, mints a session, then transparently
**reconnects** as your `authedRole` carrying the token — and persists it across reloads.

## What you get

- **Email + password** — scrypt-hashed credentials; sign-up/login return an identity + session token.
- **Sessions** — a 256-bit server-issued token, stored sha256-at-rest; `authenticate` verifies it on every
  connect. `authKit.revoke(userId)` deletes all of a user's sessions **and** disconnects their live
  connections cluster-wide (an admin ban / "sign out of all devices").
- **Roles are data** — a user's `roles[]` live on their row; only `guest` is hardcoded. Grant one by
  writing the row (`srv.collection('users').update(...)`) or `authKit.users.setRoles(id, roles)`.
- **API keys** — long-lived `slp_…` credentials with one fixed role, for services, CI, and agents. From a
  client: `createApiKey({ label, role })` (raw key returned once) · `listApiKeys()` · `revokeApiKey({ id })`.
- **JWT** — enable `jwt: { secret }`; `getToken()` issues a short-lived HS256 JWT (via `jose`) for another
  backend to verify statelessly, or to connect super-line without a DB round-trip (`params: { jwt }`).
- **Password reset** — provide a `sendPasswordReset({ user, token })` callback (delivery is yours);
  `requestPasswordReset` never reveals whether an email exists, and `confirmPasswordReset` flushes sessions.
- **Identity is all collections** — `users` is a public directory (readable); `credentials` / `sessions` /
  `apiKeys` / `passwordResets` are deny-all. Reference the directory from your own rows with
  `references: { authorId: 'users' }`, and key your policies on the `principal` (now the `userId`).

## Server-side management (provision users + agents)

`authKit` exposes an imperative surface for back-office code and provisioning — including AI-agent users:

```ts
// a passwordless user (invite flow) + a fixed-role API key it connects with
const bot = await authKit.users.create({ email: 'bot@app.dev', displayName: 'Ask AI' })
const { key } = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'agent' })
// createSuperLineClient(app, { …, params: { apiKey: key } }) → the bot is a real user on the bus
```

- `authKit.users`: `get` · `find` · `create` · `update` · `setRoles` · `deactivate` / `reactivate`
  (soft-delete: stamps `deletedAt`, flushes sessions/keys, kicks connections) · `setPassword`.
- `authKit.apiKeys`: `create` (raw key returned once) · `listFor` · `revoke`.

## Subpaths

`.` (contract fragment + schemas/types — `authContract`, `AuthContext`, `AuthUser`, …) · `/server`
(`auth()` → `authKit`) · `/client` (`authClient`) · `/react` (`createAuth`).

## Learn more

- **Guide:** <https://super-line.dogar.biz/how-to/plugin-auth>
- **Examples:** [`examples/auth`](https://github.com/mertdogar/super-line/tree/main/examples/auth) (CLI
  walkthrough) · [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat)
  (a Slack-like app with real login).
- Pairs with [`@super-line/plugin-chat`](https://www.npmjs.com/package/@super-line/plugin-chat), which builds
  its whole chat model on this identity layer.

MIT © super-line
