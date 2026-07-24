# JWT & sealed tokens

Bearer assertions from `@super-line/plugin-auth` are stateless connect credentials — a token carries its own
proof, so verifying it is a key operation instead of a database lookup. They are **server-minted only**
([ADR-0015](https://github.com/mertdogar/super-line/blob/main/docs/adr/0015-bearer-assertions-are-signed-or-sealed.md))
and delivered to a client **out-of-band**; there is no client-facing mint. Enable them with `jwt: { secret, ttlMs? }`
on `auth(...)` (`ttlMs` defaults to 15 minutes). There are two kinds — **signed** (JWS) and **sealed** (JWE) —
and they differ only in whether the token's holder can read its payload.

## The two kinds

|  | **signed** (JWS) | **sealed** (JWE) |
|---|---|---|
| payload | public — anyone holding the token can read it | opaque, even to its own holder |
| minted by | the **server** (`authKit.tokens.mintSigned`) | the **server only** (`mintSealed`) |
| verified by | anyone with the verification key | only a holder of the encryption key |
| roles from | the token's own claims | the user row, at connect |
| `authMethod` | `'jwt'` | `'jwt-sealed'` |

Both are JWTs (RFC 7519 admits either serialization) and both connect through the same `params: { jwt }` —
super-line tells them apart by shape.

## Signed — mint server-side, verify anywhere, connect

The server mints a signed assertion; there is no client-facing mint. Deliver it to a client out-of-band from an
**authenticated** route or RPC that mints it and returns it:

```ts
const { token, expiresAt } = await authKit.tokens.mintSigned(userId, { claims: { workspace: 'acme' } })
```

The point of the format is a service with none of your infrastructure — it verifies offline with `jose`, no
super-line and no database:

```ts
import { jwtVerify } from 'jose'
const { payload } = await jwtVerify(bearer, new TextEncoder().encode(secret))
console.log({ sub: payload.sub, roles: payload.roles, claims: payload.claims })
```

Or connect with it. No access-token lookup, but the connection is still first-class and `authenticate` records a
session row stamped `authMethod: 'jwt'`:

```ts
const client = createSuperLineClient(app, { role: 'user', params: { jwt } })
```

::: tip The out-of-band vend
There is no `req.user` in super-line and no way for a client to self-mint. The server mints **inside** an
authenticated route — the caller already proved who they are (e.g. an access token identifies the user), so the
server mints for that subject and hands back the token; the client then dials `params: { jwt }`. The
[`examples/react-chat-transports`](https://github.com/mertdogar/super-line/tree/main/examples/react-chat-transports)
`/signed-token` route is the reference pattern: it authenticates the caller, calls `mintSigned`, and returns the
assertion the browser connects with.
:::

## Sealed — carry a secret *through* the client

A sealed assertion is a JWE: same handshake param, but the payload is encrypted, so its own holder cannot read it.
That is what lets you route a secret **through** an untrusted client. Only the server mints one, and only your
deployment can read it:

```ts
const { token: sealedToken } = await authKit.tokens.mintSealed(userId, {
  claims: { workspace: 'acme' },              // public half — safe to show the user
  sealed: { upstreamKey: 'sk-live-…' },       // encrypted; the browser holding this cannot read it
})
```

Hand it to a browser, which connects with it exactly like a signed one — `authenticate` stamps the session
`authMethod: 'jwt-sealed'`:

```ts
createSuperLineClient(app, { role: 'user', params: { jwt: sealedToken } })
```

Server-side, both bags are on the connection context — the handler reads `ctx.sealed` decrypted and returns only
what it chooses to. **This is the closed loop:** the client handed you the key without ever being able to read it.

```ts
srv.implement({
  user: {
    useUpstream: async (_input, ctx) => {
      const key = ctx.sealed?.upstreamKey as string | undefined
      return {
        workspace: (ctx.claims?.workspace as string | undefined) ?? null,
        upstreamKeyTail: key ? `…${key.slice(-4)}` : null,
      }
    },
  },
})
```

`authKit.tokens.verify(token)` checks either kind out-of-band and returns the payloads plus the subject's
**current** roles, or `null` for anything that would not authenticate.

## Showing the public half to the client

Nothing is client-visible automatically. The public half reaches the browser through
[`env`](/how-to/connection-env) — one line, and it's validated against the `env` schema you already declared. The
sealed half never leaves the server:

```ts
auth({ contract: app, collections: backend, resolveEnv: (ctx) => ctx.claims })
```

The client reads it as `client.env` after `await client.env.ready` (the first `env` frame lands at accept;
awaiting it kills the connect-time race).

## Client: a sealed-only app (`resolveToken`)

The connects above build a client directly with `params: { jwt }`. For a browser app that is *only* ever sealed —
no password, no guest UI — [`createAuth`](/how-to/plugin-auth) can own the whole lifecycle. Its token is minted
out-of-band (the browser proves an upstream credential to a mint route; the server seals a reply), so point
`createAuth` at that source with `resolveToken`, and route it under `{ jwt }` with `tokenParam`:

```ts
const { AuthProvider, useAuth } = createAuth<typeof app, 'user'>({
  authedRole: 'user',
  tokenParam: 'jwt',                                          // → params:{ jwt } → authMethod:'jwt-sealed'
  resolveToken: async () => ({ token: await mintSealed() }), // your HTTP/tRPC mint route; return null to stay guest
  connect: ({ role, params }) => createSuperLineClient(app, { transport, role, params }),
})
```

`createAuth` boots as `guest`, `await`s the first `resolveToken()` before `ready` resolves, then swaps to `user` —
so downstream code is just `await auth.ready; auth.client`, with no hand-rolled "client not ready yet" deferred.
`resolveToken`'s token is never persisted (the source owns re-acquisition). A rejected token — or a
`rejectUnauthenticated` refusal (below) — drops back to guest and sets `state.error`:

```tsx
const { state } = useAuth()
if (state.error) return <ReconnectBanner reason={state.error.reason} />
```

## Algorithms

`jwt: { secret }` means HS256 signing plus an HKDF-derived `dir` + `A256GCM` encryption key. Override either side,
with a raw secret or a JWK:

```ts
jwt: {
  signed: { alg: 'EdDSA', key: signingJwk },        // third parties verify with the public half only
  sealed: { alg: 'dir', enc: 'A256GCM', key: cek },
  claims: z.object({ workspace: z.string() }),      // any Standard Schema — validated at mint and verify
  sealedClaims: z.object({ upstreamKey: z.string() }),
  ttlMs: 15 * 60_000,                               // default; override per-mint with expiresInMs
}
```

Verification always uses the algorithms **you configured**; the token's own header never selects a key, which is
what closes the alg-confusion attack.

## Behaviours to design around

- **A bad token degrades to `guest` by default — or set `rejectUnauthenticated`.** An expired, forged, or
  schema-drifted assertion resolves to the guest role and the connection is *accepted* there — so a client built
  for `user` would `NOT_FOUND` on every call rather than see a connect error. Either confirm with `whoami()`
  (on `shared`, returns `null` for a guest) before trusting the connection — as `authClient` does — or set
  `rejectUnauthenticated: true` on `auth(...)` so a *presented*-but-invalid credential throws `UNAUTHORIZED` at
  connect instead (a credential-less connect, and an explicit `role: 'guest'`, still resolve guest).
- **Roles come from different places.** A signed assertion carries its roles in its own claims; a sealed one does
  not — connect reads them from the user row, so a grant made after minting is live on the very next connection and
  the mint site cannot escalate anyone.
- **You cannot revoke one.** `authKit.revoke(userId)` flushes access tokens, ends sessions and disconnects live
  connections — but an outstanding assertion is in no table, so it keeps working until `exp`. Keep `ttlMs` short.
  The escape hatch is `authKit.users.deactivate(id)`: connect performs one user read (the deliberate dent in
  statelessness), so deactivation closes even a validly-signed door.

::: warning Access tokens vs. bearer assertions
Don't confuse the two. An **access token** (`params: { token }`) is a long-lived (~30-day) reusable lookup key —
whoever validates it needs your database. A **JWT bearer assertion** is short-lived (~15 min) and self-proving.
Reach for an assertion to hand identity to a service that can't call home, or to route a secret through a client.
:::

See [The auth lifecycle](/concepts/auth-lifecycle-sealed-tokens) for the why behind statelessness and revocation.

Next: [Server-side hooks](/how-to/auth-hooks) · back to [Choose an auth strategy](/how-to/choose-an-auth-strategy).
