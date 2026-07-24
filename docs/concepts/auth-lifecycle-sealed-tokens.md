# The auth lifecycle & sealed tokens

This page is a conceptual overview of the `@super-line/plugin-auth` lifecycle, and of the deliberate asymmetry between **signed (JWS)** and **sealed (JWE)** bearer assertions. It is understanding-oriented: for the runnable recipe, see [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens).

## The authentication lifecycle

An auth-enabled super-line deployment moves a user through three credentials, each with a distinct lifetime and job.

1. **Sign in.** A user authenticates once — email/password (scrypt) — and receives a long-lived, reusable **access token** (~30 days). This is the everyday credential: the client stores it and connects with `params: { token }`, and it survives reconnects until it is revoked or expires.
2. **Session connection.** Connecting with an access token establishes a durable, per-connection **session**. The `AuthContext` on `conn.ctx` tracks the user's id, roles, and connection metadata. A session is server state — it can be listed, presence-tracked, and revoked-and-disconnected.
3. **Bearer assertion.** When you need a credential that is *short-lived* or that carries a server-authored payload — to cross into another service, or to hand out temporary scoped access — the server mints a **bearer assertion** (a JWT) via `authKit.tokens.mintSigned` / `authKit.tokens.mintSealed`. Assertions are short-lived by default (~15 minutes, `jwt.ttlMs`), and a client connects with one via `params: { jwt }`.

The two credentials are not interchangeable. The **access token** is the long-lived, reusable session key; the **bearer assertion** is the short-lived, single-purpose credential for stateless and cross-service connects. Do not reach for a JWT where a session would do — reach for it precisely when you *don't* want a session.

::: warning There is no client-facing mint
Bearer assertions are **server-minted only** — the former `getToken` client request is gone. A client obtains one out-of-band: the server mints it behind an authenticated route (an access token identifies the user; the server mints for them), the client fetches it, then connects with `params: { jwt }`. See [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens).
:::

### Connecting with an assertion is *nearly* stateless

Connecting with a bearer assertion skips the **session lookup** — there is no session row to read, which is the whole point of a stateless credential. But it is not database-free: the connect path still performs exactly **one user-row read**, the deactivation check. This is "the one deliberate dent in statelessness" (ADR-0015): an assertion is stored nowhere, so `authKit.revoke()` cannot reach it and `authKit.users.deactivate()` remains the emergency stop — and honouring `deactivate` means reading the row. Frame a JWT connect as *sessionless*, not *stateless*.

## Signed vs. sealed assertions: a deliberate asymmetry (ADR-0015)

super-line's auth plugin supports two kinds of bearer assertion. **Both are minted the same way — server-side only — and both are forge-proof.** They differ in exactly one axis: what the assertion exposes to whoever holds it.

### Signed assertions (JWS)

- **Format**: JSON Web Signature. The `claims` payload is base64 — public by construction.
- **Visibility**: the holder can read `claims`. Anyone who intercepts the token can decode it (e.g. via `jwt.io`) and read the data.
- **Verification**: a third party holding the verification key can check the signature and *trust* the claims. That third-party verifiability is the whole purpose of the signed kind.
- **Minting**: `authKit.tokens.mintSigned(userId, { claims?, expiresInMs? })`. The server authors the public `claims`.
- **On the connection**: `ctx.claims`; `authMethod` is `'jwt'`.

### Sealed assertions (JWE)

- **Format**: JSON Web Encryption using AEAD (authenticated encryption).
- **Visibility**: the `sealed` payload (and any `claims`) is entirely opaque to the token's holder. It tells its holder *nothing*.
- **Verification**: only a party holding the encryption key can decrypt and read either bag.
- **Minting**: `authKit.tokens.mintSealed(userId, { claims?, sealed?, expiresInMs? })` — server-only, exactly like `mintSigned`.
- **On the connection**: `ctx.claims` and `ctx.sealed`; `authMethod` is `'jwt-sealed'`.

Both kinds land on `conn.ctx` and are dispatched by the server on the compact dot count (2 = JWS, 4 = JWE). The **only** difference is readability: a signed assertion's `claims` are public to its holder; a sealed assertion's payload is encrypted and opaque even to the holder.

## Both kinds are server-authored

This is the headline of the 2026-07-24 update to ADR-0015. Since client-side minting was retired, **there is no client-facing mint at all** — so `ctx.claims` is server-authored on a signed assertion just as `ctx.sealed` is on a sealed one. The kinds now differ *only* in whether the holder can *read* the payload, never in who *authors* it. Both are forge-proof; a JWS is signed and a JWE is AEAD-authenticated, so neither can be tampered with in flight.

## Why are sealed assertions server-minted only?

The restriction is a load-bearing security invariant, not a limitation. Because a client can neither read *nor* generate the contents of a sealed assertion, any `sealed` payload attached to a verified connection's `ctx` is **guaranteed to be server-authored**.

If clients could mint sealed assertions, a malicious actor could embed arbitrary data into one. The server cannot distinguish a client-authored encrypted payload from a server-authored one on receipt, so trusting `ctx.sealed` would become unsafe — and the signed/sealed distinction would stop carrying any information (ADR-0015: "a client that can mint a sealed payload makes `ctx.sealed` exactly as trustworthy as `ctx.claims`, which is to say not at all"). By restricting minting to the server, super-line guarantees that when your connection handler reads `ctx.sealed`, that data unquestionably originated from your trusted backend.

## Choosing a kind

- **Reach for a signed assertion (JWS) when**:
  - You need to pass identity context to a third-party service that holds your verification key.
  - The client itself needs to read the payload to drive UI logic (surfaced to the client through `env` via `resolveEnv: (ctx) => ctx.claims`).
  - The payload carries nothing sensitive.
- **Reach for a sealed assertion (JWE) when**:
  - You are issuing temporary access to an internal resource (a secure download link, an invite code).
  - The payload carries routing flags, internal permissions, or state that must not be exposed to the client or a network sniffer.
  - You need to guarantee the payload was authored exclusively by the server.

::: tip Payloads travel in the connect params
An assertion carries its payload in the URL query string, so a large payload can approach browser URL limits (~2k). Keep `claims` / `sealed` small — they are for identity and routing context, not for shipping documents.
:::

Related: the runnable recipe is [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens); the credentials it builds on are covered in [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys); how a signed payload reaches the client is [Connection env](/how-to/connection-env). Start from [Choose an auth strategy](/how-to/choose-an-auth-strategy).
