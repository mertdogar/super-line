# ADR-0015: Bearer assertions come in two kinds — signed and sealed

**Status:** accepted (2026-07-23) · **Builds on:** ADR-0012 (connection `env`), ADR-0013 (Standard
Schema slots) · **Prompted by:** a `/grill-with-docs` session on carrying host payloads through JWT auth

## Context

`plugin-auth` shipped JWT support as a single thing: `getToken()` mints an HS256 **JWS** carrying
`sub` + `roles`, and `params: { jwt }` connects with it. Two limitations surfaced together.

First, there was **nowhere to put host data**. A deployment that wants a connection to carry a
workspace id, a tenant, or an upstream credential had to look it up again on every connect, keyed
off the user — even though the minting site already knew it.

Second, and less obviously, a JWS **cannot hold a secret**. Its payload is base64, so every claim is
readable by whoever holds the token. "Private" data in a JWS is private only by convention.

A third problem was already latent: `getToken` is a *client* request, so any authenticated client can
mint a token. Whatever a token asserts, a client can therefore assert about itself. That was harmless
while tokens carried only `sub` and `roles` (both server-derived); it stops being harmless the moment
tokens carry a payload the server later reads back.

## Decision

Split the credential into two kinds, both JWTs (RFC 7519 admits a claims set in JWS *or* JWE form),
both arriving on the same `params: { jwt }`, dispatched on the compact dot count (2 = JWS, 4 = JWE).

- A **signed assertion** (JWS) carries a public `claims` bag. Mintable by a client
  (`getToken({ claims })`) or the server (`authKit.tokens.mintSigned`). Third parties holding the
  verification key can check it — that is its purpose.
- A **sealed assertion** (JWE) carries `claims` *and* a `sealed` bag, and is **server-minted only**
  (`authKit.tokens.mintSealed`). It is opaque to its own holder; only a party with the encryption key
  can read either bag.

Both land on `conn.ctx` as `ctx.claims` / `ctx.sealed`, and `authMethod` distinguishes provenance:
`'jwt'` for signed, `'jwt-sealed'` for sealed.

**Roles come from the user row for a sealed assertion**, and from the token for a signed one. The
connect path already reads the user row (the deactivation check), so this costs nothing.

**The public half reaches the client through `env`, not a new primitive.** A host writes
`resolveEnv: (ctx) => ctx.claims`. This is the one seam that had to exist and already did (ADR-0012).

**Payloads are validated by host-supplied Standard Schemas** (`jwt.claims`, `jwt.sealedClaims`) at
mint *and* at verify. Verify-time validation cannot catch tampering — a JWS is signed and a JWE is
AEAD-authenticated — it catches exactly one thing: a token minted before a schema change. That fails
closed to guest.

**Algorithms are configurable but pinned.** `jwt: { secret }` still means HS256 signing plus an
HKDF-SHA256-derived `dir`/`A256GCM` content-encryption key; `signed.alg` / `sealed.alg` / `sealed.enc`
and JWK keys override. Every verification passes the *configured* algorithms to jose explicitly and
**never reads the algorithm from the token's own header**.

## Considered alternatives

- **One token kind with an encrypted claim nested inside a JWS.** Rejected: it keeps third-party
  verifiability for a payload no third party can read anyway, and produces a token that is signed *and*
  encrypted with two key configs to reason about, for no property a JWE lacks.
- **Letting clients mint sealed assertions.** Rejected — it is the whole point of the split. A client
  that can mint a sealed payload makes `ctx.sealed` exactly as trustworthy as `ctx.claims`, which is to
  say not at all, and the distinction stops carrying information.
- **Sealed assertions carrying their own roles** (`mintSealed(userId, { roles })`). Rejected: it turns
  payload delivery into a capability-granting system nobody asked for, and staleness would survive
  `setRoles` until expiry. Intersecting token roles with row roles is the safe version if scoped tokens
  are ever wanted; it is additive.
- **Identity-free capability tokens** (no `sub`). Rejected: with no `userId` there is no `principal`,
  so every collection policy denies and a parallel authorization story would have to be invented.
- **Auto-seeding `env` from the public payload.** Rejected: `env` is contract-typed per role and
  validated on write, so auto-seeding arbitrary claims either fails validation at connect or bypasses
  the schema — and it would silently overwrite the host's own `resolveEnv` with no principled
  precedence rule.
- **Declaring the payload schemas on the contract** (like collections). Rejected: the client-visible
  half is already contract-typed as `env`; declaring it again invites two schemas that drift apart. The
  sealed half is server-only and has no business on a client-visible contract.
- **A new `assertions:` config block.** Rejected: `jwt: { secret }` is published API and, since a bare
  string can only be symmetric, it is already the correct zero-config spelling.

## Consequences

**Gained.** Server-authored per-connection payloads that survive a stateless reconnect, with a real
confidentiality boundary rather than a documented convention. Algorithm agility (EdDSA/ES256 signing,
asymmetric or symmetric encryption) without alg-confusion exposure. `authMethod` now records payload
provenance, so the `sessions` collection and the Control Center show it for free.

**Given up / accepted.** `ctx.claims` on a *signed* assertion is **client-authored** — the docs say
plainly never to authorize on it without checking `authMethod === 'jwt-sealed'`. Sealed assertions
inherit the JWT bargain: stored nowhere, so `revoke()` cannot reach them and `users.deactivate()`
remains the emergency stop. Assertions travel in a URL query string, so a large payload can approach
browser URL limits (~2k); with `dir` there is no key-wrapping overhead, so that is a cap on payload
size and is documented rather than enforced.
