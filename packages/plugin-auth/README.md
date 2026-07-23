# @super-line/plugin-auth

First-party **authentication** for [**super-line**](https://super-line.dogar.biz/), as a paired plugin:
email/password sign-up + login, reusable **access tokens**, connection **sessions**, data-driven **roles**, **API keys**, and
**JWT** — with all identity held in typed [collections](https://super-line.dogar.biz/collections/). It
builds on super-line's connect-time [`authenticate`](https://super-line.dogar.biz/how-to/roles-auth)
model; you wire it in three places and the plugin owns the rest.

```bash
pnpm add @super-line/plugin-auth
```

## Wire it in — three touch-points

```ts
// 1 · contract — authContract() adds the `guest` role and the auth collections
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

const backend = sqliteCollections({ file: 'app.db', collections: app.collections })
const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })

createSuperLineServer(app, {
  nodeKey: 'app-replica-1',        // stable for this replica across restarts
  collections: backend,
  authenticate: authKit.authenticate, // verifies a credential and creates a connection session
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
client half hides the dance: `signIn()` connects as `guest`, mints an access token, then transparently
**reconnects** as your `authedRole` carrying the token — and persists it across reloads.

## What you get

- **Email + password** — scrypt-hashed credentials; sign-up/login return an identity + access token.
- **Access tokens** — reusable 256-bit bearer grants, stored sha256-at-rest, that browsers can persist
  across reconnects.
- **Sessions** — append-only rows for accepted authenticated connections, including API-key and JWT
  connections. They record node ownership, authentication provenance, heartbeat freshness, and `endedAt`.
- **Roles are data** — a user's `roles[]` live on their row; only `guest` is hardcoded. Grant one by
  writing the row (`srv.collection('users').update(...)`) or `authKit.users.setRoles(id, roles)`.
- **API keys** — long-lived `slp_…` credentials with one fixed role, for services, CI, and agents. From a
  client: `createApiKey({ label, role })` (raw key returned once) · `listApiKeys()` · `revokeApiKey({ id })`.
- **JWT** — enable `jwt: { secret }`; `getToken()` issues a short-lived HS256 JWT (via `jose`) for another
  backend to verify statelessly, or to connect super-line without a DB round-trip (`params: { jwt }`). It
  cannot be revoked — keep the TTL short; `users.deactivate()` is the emergency stop. Demonstrated in
  [`examples/auth`](https://github.com/mertdogar/super-line/tree/main/examples/auth) (CLI) and
  [`examples/react-chat-transports`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-transports)
  (browser panel + a separate verifier service).
- **Password reset** — provide a `sendPasswordReset({ user, token })` callback (delivery is yours);
  `requestPasswordReset` never reveals whether an email exists, and `confirmPasswordReset` revokes access tokens.
- **Identity is all collections** — `users` and `userPresence` are public by default; `credentials` /
  `accessTokens` / `sessions` / `apiKeys` / `passwordResets` are deny-all. Reference the directory from your own rows with
  `references: { authorId: 'users' }`, and key your policies on the `principal` (now the `userId`).

## `authKit` — the server API

`auth({ contract, collections, defaultRoles?, jwt?, sendPasswordReset? })` returns the kit you wire into the
server and drive from back-office code:

```ts
interface AuthServer {
  // ── wiring ──────────────────────────────────────────────────────────────────────
  authenticate(handshake): Promise<{ role, ctx: AuthContext }> // → server `authenticate:`
  identify(conn): string | undefined                           // → server `identify:` (principal := userId)
  plugin: SuperLinePlugin                                       // → server `plugins: [...]`
  revoke(userId: string): Promise<void>  // revoke access tokens, end sessions, and disconnect live connections

  // ── users: provisioning + back-office (requires the running server) ───────────────
  users: {
    get(id): Promise<AuthUser | undefined>
    find(opts?: { filter?, limit?, offset?, includeDeactivated? }): Promise<AuthUser[]>
    create(input: { displayName, roles?, metadata? }): Promise<AuthUser>
    update(id, patch: { displayName?, metadata? }): Promise<AuthUser>
    setRoles(id, roles: string[]): Promise<void>       // validated against contract roles (connect-time)
    deactivate(id): Promise<void>   // soft-delete: stamp deletedAt, flush sessions/keys/resets, kick connections
    reactivate(id): Promise<void>   // lift the deactivation
  }

  credentials: {
    create(userId, input: { email, password? }): Promise<AuthCredential> // omit password → invitation
    setPassword(userId, newPassword): Promise<void> // revokes access + reset tokens
  }

  // ── apiKeys: agent + service provisioning (requires the running server) ───────────
  apiKeys: {
    create(userId, opts: { role, label, expiresInMs? }): Promise<ApiKeyInfo & { key }> // raw slp_… returned ONCE
    listFor(userId): Promise<ApiKeyInfo[]>
    revoke(id): Promise<void>
  }
}
```

Provision an AI-agent (or any headless service) as a real user:

```ts
const bot = await authKit.users.create({ displayName: 'Ask AI' })
const { key } = await authKit.apiKeys.create(bot.id, { role: 'user', label: 'agent' })
// createSuperLineClient(app, { …, params: { apiKey: key } }) → the bot is a real user on the bus
```

**Client-side requests** (typed methods on a connected client): `signUp` · `signIn` · `signOut` · `whoami`
· `createApiKey({ label, role, expiresInMs? })` (raw key once) · `listApiKeys` · `revokeApiKey({ id })` ·
`getToken` (JWT; needs `jwt:` enabled) · `requestPasswordReset` · `confirmPasswordReset`. In React/JS they
sit behind `createAuth()` / `authClient()` as `signIn` / `signUp` / `signOut` + reactive `state`.

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
