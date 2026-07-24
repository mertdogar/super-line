# Sessions, roles & API keys

`@super-line/plugin-auth` issues a durable **session** for every authenticated connection, treats a user's
**roles** as data on their row, and mints fixed-role **API keys** — all held in the auth [collections](/collections/),
so nothing here is a side store.

## Sessions — one per connection

Every accepted authenticated connect — an access token, an API key, or a bearer assertion — records a session row.
Handlers see `ctx.sessionId` and `ctx.authMethod` (`'access-token'` | `'api-key'` | `'jwt'` | `'jwt-sealed'`); the
transport heartbeat updates `lastSeenAt`, and disconnect stamps `endedAt`. A guest connection has no session.

```ts
srv.implement({
  user: {
    doWork: async (_input, ctx) => {
      log('session', ctx.sessionId, 'via', ctx.authMethod) // e.g. …/'jwt-sealed'
    },
  },
})
```

Sessions live in the `sessions` collection (server-only), so you can read them back — a jwt connection lands its
own row, stamped with how it authenticated:

```ts
const jwtSession = (await srv.collection('sessions').snapshot()).find((s) => s.authMethod === 'jwt')
// → { authMethod: 'jwt', userId, connectedAt, lastSeenAt, endedAt, … }
```

::: warning A stable `nodeKey` is required
Sessions key on the server's identity, so `createSuperLineServer({ nodeKey })` **must** be stable across restarts —
the server throws at boot without one. A changing `nodeKey` orphans every prior-boot session row.
:::

## Roles are data

A user's `roles[]` live on their row. The client declares which role it wants; `authenticate` validates it's granted
(`guest` is the only hardcoded role). Grant a role by writing the user row:

```ts
await srv.collection('users').update({ ...user, roles: ['user', 'admin'] })
```

Co-writing the row is the whole mechanism — the next connection carrying that user's access token can open the new
role, because `authenticate` re-reads the granted roles at connect:

```ts
await srv.collection('users').update({ id: aliceId, displayName: 'Alice', roles: ['user', 'admin'], createdAt: Date.now() })
const guest = createSuperLineClient(app, { transport: transport(), role: 'guest' })
const { token } = await guest.signIn({ email: 'alice@example.com', password: 'correct-horse' }) // fresh access token
guest.close()
const adminAlice = createSuperLineClient(app, { transport: transport(), role: 'admin', params: { token } })
await adminAlice.stats() // the same token now authorizes 'admin'
```

- `defaultRoles` on `auth(...)` (default `['user']`) seeds every sign-up.
- `authKit.users.setRoles(id, roles)` is the server-side kit equivalent of the co-write above (validated against
  the contract's roles). It isn't shown in the runnable example, but it's there for back-office code.

## API keys

Long-lived credentials with one fixed role, for services and CI:

```ts
const { key } = await client.createApiKey({ label: 'ci', role: 'user' }) // the raw key is returned ONCE
// a service connects with it and receives a normal connection session:
createSuperLineClient(app, { role: 'user', params: { apiKey: key } })
```

`listApiKeys()` and `revokeApiKey({ id })` manage them.

Provision one server-side with the imperative kit — the raw `slp_…` key comes back once, so audit it and never log
it whole:

```ts
const { key: scoutKey } = await authKit.apiKeys.create(scoutUser.id, { role: 'user', label: 'scout-agent' })
const scout = createSuperLineClient(app, { transport: transport(), role: 'user', params: { apiKey: scoutKey } })
```

Agents are typically API-key-only (no password, so no credential row) — see [Agent identity](/how-to/auth-agent-identity)
for the full provisioning flow.

## User presence

The plugin maintains a world-readable `userPresence` collection, keyed by `userId` with fields
`{ userId, connectedAt, lastSeenAt }`, derived from sessions with no app code. A client just subscribes to it; a
row counts as **online** while its `lastSeenAt` is within `USER_PRESENCE_LIVE_MS` (~90s, exported from
`@super-line/plugin-auth`).

```ts
const presence = client.collection('userPresence').subscribe({})
await presence.ready
const online = presence.rows().filter((r) => Date.now() - (r.lastSeenAt ?? 0) < USER_PRESENCE_LIVE_MS)
```

Next: [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens) · back to [Choose an auth strategy](/how-to/choose-an-auth-strategy).
