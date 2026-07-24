# Authentication — `@super-line/plugin-auth`

Proper authentication as a **paired plugin**: email/password sign-up + login, reusable **access tokens**, connection **sessions**,
data-driven **roles**, **API keys**, and **JWT** — with all identity held in typed [collections](/collections/).
It builds on super-line's connect-time [`authenticate`](/how-to/roles-auth) model; you wire it in three places
and the plugin owns the rest.

```bash
pnpm add @super-line/core @super-line/plugin-auth
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

## Bearer assertions (JWT / JWE)

An access token is a **lookup key** — whoever validates it needs your database. A bearer assertion carries its
own proof, so verification is a key operation instead. Enable it with `jwt: { secret, ttlMs? }` on `auth(...)`
(`ttlMs` defaults to 15 minutes).

There are **two kinds**, and the difference is who can read the payload:

|  | **signed** (JWS) | **sealed** (JWE) |
|---|---|---|
| payload | public — anyone holding the token can read it | opaque, even to its own holder |
| minted by | a client (`getToken`) **or** the server | the **server only** |
| verified by | anyone with the verification key | only a holder of the encryption key |
| roles from | the token's own claims | the user row, at connect |
| `authMethod` | `'jwt'` | `'jwt-sealed'` |

Both are JWTs (RFC 7519 admits either serialization) and both connect through the same
`params: { jwt }` — super-line tells them apart by shape.

### Signed — mint, verify anywhere, connect

`getToken()` is on `shared`, so any authenticated connection can call it:

```ts
const { jwt, expiresAt } = await client.getToken()                 // sub = userId, roles, jti, exp
const { jwt: tagged } = await client.getToken({ claims: { workspace: 'acme' } })
```

The point of the format is a service with none of your infrastructure:

```ts
import { jwtVerify } from 'jose'
const { payload } = await jwtVerify(bearer, new TextEncoder().encode(secret)) // no super-line, no DB
```

### Sealed — carry a secret *through* the client

Only the server mints one, and only your deployment can read it:

```ts
const { token } = await authKit.tokens.mintSealed(userId, {
  claims: { workspace: 'acme' },              // public half — safe to show the user
  sealed: { upstreamKey: 'sk-live-…' },       // encrypted; the browser holding this cannot read it
  expiresInMs: 5 * 60_000,
})
```

Hand it to a browser, which connects with it exactly like a signed one:

```ts
createSuperLineClient(app, { role: 'user', params: { jwt: token } })
```

Server-side, both bags are on the connection context:

```ts
srv.implement({ user: { doWork: async (_i, ctx) => callUpstream(ctx.sealed.upstreamKey) } })
```

`authKit.tokens.verify(token)` checks either kind out-of-band and returns the payloads plus the subject's
**current** roles, or `null` for anything that would not authenticate.

### Showing the public half to the client

Nothing is client-visible automatically. The public half reaches the browser through
[`env`](/how-to/connection-env) — one line, and it's validated against the `env` schema you already declared:

```ts
auth({ contract: app, collections: backend, resolveEnv: (ctx) => ctx.claims })
```

### Algorithms

`jwt: { secret }` means HS256 signing plus an HKDF-derived `dir` + `A256GCM` encryption key. Override either
side, with a raw secret or a JWK:

```ts
jwt: {
  signed: { alg: 'EdDSA', key: signingJwk },        // third parties verify with the public half only
  sealed: { alg: 'dir', enc: 'A256GCM', key: cek },
  claims: z.object({ workspace: z.string() }),      // any Standard Schema — validated at mint and verify
  sealedClaims: z.object({ upstreamKey: z.string() }),
}
```

Verification always uses the algorithms **you configured**; the token's own header never selects a key, which
is what closes the alg-confusion attack.

### Behaviours to design around

- **`ctx.claims` on a signed assertion is client-authored.** `getToken` is a client request, so a user can put
  anything there (subject to your `claims` schema). **Never authorize on it** unless
  `ctx.authMethod === 'jwt-sealed'` — only a sealed assertion's payloads are server-minted.
- **A role is required.** Connecting without one is a `BAD_REQUEST`; asking for a role the assertion doesn't
  grant is `FORBIDDEN`.
- **A bad token degrades to `guest`, it does not throw.** An expired, forged, or schema-drifted assertion
  resolves to the guest role and the connection is *accepted* there — so a client built for `user` will get
  `NOT_FOUND` on every call rather than a connect error. Confirm with `whoami()` (it's on `shared`, and returns
  `null` for a guest) before trusting the connection, exactly as `authClient` does when it restores a stored
  access token.
- **You cannot revoke one.** `revoke(userId)` flushes access tokens, ends sessions and disconnects live
  connections — but an outstanding assertion is in no table, so it keeps working until `exp`. Keep `ttlMs` short.
  The escape hatch is `users.deactivate(id)`: connect performs one user read (the deliberate dent in
  statelessness), so deactivation closes even a validly-signed door.
- **Assertions ride in the URL query string.** A large `sealed` payload can approach browser URL limits (~2k).

Both kinds are demonstrated end to end — the CLI narrative in [`examples/auth`](https://github.com/mertdogar/super-line/tree/main/examples/auth),
and a browser panel with a separate verifier service in
[`examples/react-chat-transports`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-transports).
The design is recorded in [ADR-0015](https://github.com/mertdogar/super-line/blob/main/docs/adr/0015-bearer-assertions-are-signed-or-sealed.md).

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

## Extending auth with hooks

Every **server-invoked** auth operation takes a before/after hook (ADR-0017): `authenticate` and the
imperative kit. They are the seam for connection admission, agent-provisioning policy, and audit — an
extension a host can't bypass because it wraps the operation itself:

```ts
const authKit = auth({
  contract: app,
  collections: backend,
  hooks: {
    // authenticate — before/after the connection identity resolves
    authenticate: {
      before: (handshake) => { if (blocked(handshake.headers['x-forwarded-for'])) throw new SuperLineError('FORBIDDEN', 'blocked') },
      after: (result) => ({ ...result, ctx: { ...result.ctx, tenant: tenantOf(result.ctx.userId) } }), // enrich / override / reject
    },
    // the imperative kit — nested to mirror authKit.<surface>.<method>
    users: {
      create: { before: (i) => ({ ...i, displayName: i.displayName.trim() }), after: (u) => audit('user.create', u.id) },
      deactivate: { after: () => notifySecurity() },
    },
    credentials: { setPassword: { before: (i) => assertStrong(i.newPassword) } }, // policy on the provisioning path
    apiKeys: { create: { after: (r) => vault.store(r.key) } },
  },
})
```

Semantics:

- **`before` transforms or vetoes.** Return a new input to transform; throw to veto (nothing is written).
  `authenticate.before` rewrites the `Handshake`; a throw rejects the connection.
- **`after` observes.** A throw propagates to the caller, but the write already committed and **stays**.
  `authenticate.after` is the exception — it may *transform* the resolved result (enrich `ctx`, override
  `env`, change `role`) or reject, because `authenticate` commits nothing.
- **`users.deactivate.before` cannot veto.** It's the emergency stop for a compromised account — a throw is
  routed to `onHookError` (default `console.error`) and the deactivation proceeds. Host code must never be
  able to block incident response.
- **Cascades are silent.** `users.deactivate` and `credentials.setPassword` internally revoke keys/tokens/
  sessions; those internal writes fire **no** `apiKeys.revoke`/`tokens.*` hooks. Audit the composite, not the
  leaves.

::: warning Hook payloads carry raw secrets
`authenticate.before` sees the handshake's bearer tokens (`query.jwt` / `query.apiKey`); `credentials.*.before`
sees the plaintext password; `apiKeys.create.after` sees the raw `slp_…` key; `tokens.*.after` sees the minted
token. **Never log a payload wholesale** (`after: (r) => log(r)` writes a live credential to disk).
:::

**Client requests are not hooked.** `signIn`/`signUp`/… run over the wire and already have a veto seam — the
server's `use:` middleware chain sees each by name (`info.name`) and rejects by throwing (it cannot read the
request body, so a password-policy check belongs on the hooked `authKit.credentials.create` path). Disconnect
logic is `createSuperLineServer({ onDisconnect: (conn, ctx, code) => … })`, with `ctx` typed as the resolved
`AuthContext`.

## Examples

- **`examples/auth`** — a runnable CLI walkthrough of the whole flow.
- **`examples/collections-chat`** — a Slack-like app with real login, on top of collections.
