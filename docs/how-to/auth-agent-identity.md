# Provision an agent identity

super-line has no bot type. An AI agent or service is an ordinary API-key **user**, provisioned
server-side with `authKit` from `@super-line/plugin-auth/server`. Because profiles and credentials are
separate imperative surfaces, an API-key-only identity has no empty credential row — you create the user,
mint a key, and the agent connects as itself.

## Provision an agent

Create the user, then mint an API key for it. The agent connects with `params: { apiKey }` and acts as
itself — its writes carry its own `userId`, so row policies key on the agent exactly as they do on a person.

```ts
const scoutUser = await authKit.users.create({ displayName: 'scout', roles: ['user'], metadata: { kind: 'agent' } })
const { key } = await authKit.apiKeys.create(scoutUser.id, { role: 'user', label: 'scout-agent' })
```

From [`examples/auth`](https://github.com/mertdogar/super-line/tree/main/examples/auth) — the agent connects
and writes as itself, no credential row ever created:

```ts
const scoutUser = await authKit.users.create({ displayName: 'scout', roles: ['user'], metadata: { kind: 'agent' } })
console.log('  scout metadata →', scoutUser.metadata) // { kind:'agent', provisionedVia:'agent-kit' } — the transform landed
const { key: scoutKey } = await authKit.apiKeys.create(scoutUser.id, { role: 'user', label: 'scout-agent' })

// The minted key authenticates: scout connects with `params: { apiKey }` and acts as itself.
const scout = createSuperLineClient(app, { transport: transport(), role: 'user', params: { apiKey: scoutKey } })
console.log('  scout whoami →', await scout.whoami()) // { userId, displayName:'scout', roles:['user'] }
await scout.collection('notes').insert({ id: 'n3', ownerId: scoutUser.id, text: 'recon complete', createdAt: Date.now() })
console.log('  scout wrote a note as itself')
scout.close()
```

::: tip The raw key is returned once
`apiKeys.create` returns the raw `slp_…` key a single time. Store it where the agent will read it (a vault, a
secret env var) at provisioning; you cannot recover it later. An API key is long-lived with one fixed role.
:::

Agents that also call tools or an LLM inline are covered in [Build with AI agents](/how-to/ai-agents).

## Manage identities from server code

The kit exposes imperative surfaces for back-office code and provisioning — including AI-agent users. They need
the running server (the co-writer binds at plugin setup):

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

- Users **soft-delete** rather than vanish — `deactivate` stamps `deletedAt`, `reactivate` lifts it, and old
  rows keep rendering author names.
- `users.find` excludes deactivated users unless you pass `includeDeactivated`.
- `authKit.tokens.{mintSigned,mintSealed,verify}` mint and check [bearer assertions](/how-to/auth-jwt-sealed-tokens) —
  also server-side, also needing the running server.

## Revoke & lock out

`await authKit.revoke(userId)` flushes the user's access tokens, ends their sessions, and disconnects their live
connections cluster-wide (an admin ban or "sign out of all devices"). It does **not** touch API keys or
outstanding JWT assertions:

- **API keys** survive `revoke` — retire them per-key with `authKit.apiKeys.revoke(id)`.
- **Bearer assertions** are in no table, so nothing revokes them; keep their `ttlMs` short.

For a compromised account, `authKit.users.deactivate(userId)` is the emergency stop that even closes the
signed-assertion door — connect reads the user row, so a deactivated user resolves to `guest` on the very next
connect. From [`examples/auth`](https://github.com/mertdogar/super-line/tree/main/examples/auth):

```ts
// 3 · The cost of statelessness, stated plainly. `revoke` flushes access tokens, ends sessions and
//     disconnects Bob everywhere — but an outstanding JWT is in no table, so there is nothing to
//     revoke. It keeps working until it expires. Short TTLs are the mitigation, not revocation.
console.log('\n— Bob is revoked —')
await authKit.revoke(bobId)
const afterRevoke = createSuperLineClient(app, { transport: transport(), role: 'user', params: { jwt } })
console.log('  whoami over jwt →', await afterRevoke.whoami()) // still Bob — the signature is still valid
afterRevoke.close()

// 4 · …and the emergency stop. `resolveBase` reads the user row to check for deactivation — the one
//     deliberate dent in statelessness — so deactivating Bob closes even the signed door.
console.log('\n— Bob is deactivated —')
await authKit.users.deactivate(bobId)
const afterDeactivate = createSuperLineClient(app, { transport: transport(), role: 'user', params: { jwt } })
console.log('  whoami over jwt →', await afterDeactivate.whoami()) // null — accepted as a guest
afterDeactivate.close()
```

Next: [Reset a password](/how-to/auth-password-reset) · back to [Choose an auth strategy](/how-to/choose-an-auth-strategy).
