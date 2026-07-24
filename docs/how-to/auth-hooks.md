# Server-side hooks

`hooks` on `auth({...})` wrap every **server-invoked** auth operation (ADR-0017) — `authenticate` and the
imperative kit — with `before`/`after`. They are the seam for connection admission, agent-provisioning policy,
and audit: an extension a host can't bypass because it wraps the operation itself. Client request handlers
(`signIn`/`signUp`/`signOut`/`createApiKey`) are **not** hooked — those run over the wire and already have a veto
seam in the server's `use:` middleware chain.

## Wire hooks into `auth()`

`hooks` is one object on the kit, nested to mirror `authKit.<surface>.<method>`:

```ts
const authKit = auth({
  contract: app,
  collections: backend,
  hooks: {
    authenticate: {
      before: (handshake) => { if (blocked(handshake.headers['x-forwarded-for'])) throw new SuperLineError('FORBIDDEN', 'blocked') },
      after: (result) => ({ ...result, ctx: { ...result.ctx, tenant: tenantOf(result.ctx.userId) } }),
    },
    users: {
      create: { before: (i) => ({ ...i, displayName: i.displayName.trim() }), after: (u) => audit('user.create', u.id) },
      deactivate: { after: () => notifySecurity() },
    },
    credentials: { setPassword: { before: (i) => assertStrong(i.newPassword) } },
    apiKeys: { create: { after: (r) => vault.store(r.key) } },
  },
})
```

## `authenticate` hooks

`before` inspects or rewrites the raw `Handshake`, or throws to **reject the connection**. `after` fires for
every resolution — guests included — and may transform the result (enrich `ctx`, override `env`, change `role`).

```ts
hooks: {
  authenticate: {
    // before: inspect/rewrite the raw handshake, or throw to REJECT the connection. The transport
    // swallows a rejected authentication into a bare 401 (no server-side log, no onError), so a record
    // of blocked connections must be logged HERE, before the throw. NB: the WS client may re-attempt a
    // rejected handshake, so `authenticate` can run more than once per connect — keep it idempotent
    // (this is a pure check, so it is). That's why the audit line below can appear more than once.
    before: (handshake) => {
      if (handshake.query.banned) {
        console.log('  ⛔ authenticate rejected a banned handshake')
        throw new SuperLineError('FORBIDDEN', 'connection blocked by policy')
      }
    },
    // after: fires for EVERY resolution (guests included) — a connection audit trail. It can also
    // transform the result (enrich ctx, override env); here it only observes.
    after: (result) => console.log('  → connect:', result.role, 'via', result.ctx.authMethod ?? 'guest'),
  },
}
```

A rejected handshake is refused at the upgrade, which does not carry the server's reason — so the client just
sees the connection close as `DISCONNECTED`, and its first request drops:

```ts
const banned = createSuperLineClient(app, { transport: transport(), role: 'guest', params: { banned: '1' }, reconnect: false })
await banned.whoami().then(
  () => console.log('  connected?! — the hook should have refused this'),
  (err) => console.log('  refused →', (err as SuperLineError).code), // DISCONNECTED — authenticate.before threw
)
```

::: tip Log before you throw, and stay idempotent
A rejected authentication becomes a bare 401 — no server log, no `onError`. Record blocked connections in the
`before`, ahead of the throw. And because the WS client may re-attempt a rejected handshake, `authenticate` can
run more than once per connect: keep the `before` a pure, repeatable check. `reconnect: false` surfaces the
refusal at once instead of retrying forever.
:::

## Hooks on the imperative kit

The provisioning kit trips the nested hooks. `before` transforms the input (return a new one); `after` observes:

```ts
hooks: {
  users: {
    // before TRANSFORMS: stamp provenance onto every server-provisioned identity (a returned input).
    create: {
      before: (input) => ({ ...input, metadata: { ...input.metadata, provisionedVia: 'agent-kit' } }),
      after: (user) => console.log('  audit: user.create →', user.displayName),
    },
    // `deactivate.before` is NON-vetoable: a throw here is routed to `onHookError` and the
    // deactivation proceeds anyway — the emergency stop must never be blockable by host code.
    deactivate: { before: ({ id }) => console.log('  ⚠ security: deactivating', id, '— revoking everything') },
  },
  apiKeys: {
    create: {
      after: (key) =>
        // ⚠ the RAW `slp_…` key is right here. Audit the id; NEVER log the whole key —
        // `after: (k) => log(k)` would write a live credential to disk. Mirror it to a vault, at most.
        console.log('  minted api key', key.id, 'ending …' + key.key.slice(-4)),
    },
  },
  tokens: {
    mintSealed: {
      after: (token) =>
        console.log('  audit: sealed assertion minted, expires', new Date(token.expiresAt).toISOString()),
    },
  },
}
```

- **`users.create.before` transforms** a returned input (stamp provenance); `after` observes the created row.
- **`users.deactivate.before` cannot veto** — a throw routes to `onHookError` and deactivation proceeds. The
  emergency stop for a compromised account must never be blockable.
- **`apiKeys.create.after`** sees the raw `slp_…` key in the payload — audit the id, never the key.

## Behaviours

- **`before` transforms or vetoes.** Return a new input to transform; throw to veto (nothing is written).
  `authenticate.before` rewrites the `Handshake`; a throw rejects the connection.
- **`after` observes.** A throw propagates to the caller, but the write already committed and **stays**.
  `authenticate.after` is the exception — it may *transform* the resolved result (enrich `ctx`, override
  `env`, change `role`) or reject, because `authenticate` commits nothing.
- **Cascades are silent.** `users.deactivate` and `credentials.setPassword` internally revoke keys/tokens/
  sessions; those internal writes fire **no** `apiKeys.revoke`/`tokens.*` hooks. Audit the composite, not the
  leaves.
- **`onHookError` defaults to `console.error`** — it catches a non-vetoable throw (`deactivate.before`) and any
  `after` throw you don't want to reach the caller.

::: warning Hook payloads carry raw secrets
`authenticate.before` sees the handshake's bearer tokens (`query.jwt` / `query.apiKey`); `credentials.*.before`
sees the plaintext password; `apiKeys.create.after` sees the raw `slp_…` key; `tokens.*.after` sees the minted
token. **Never log a payload wholesale** (`after: (r) => log(r)` writes a live credential to disk).
:::

Next: [Provision an agent identity](/how-to/auth-agent-identity) · back to [Choose an auth strategy](/how-to/choose-an-auth-strategy).
