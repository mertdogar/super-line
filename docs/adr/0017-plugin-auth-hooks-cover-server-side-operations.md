# ADR-0017: plugin-auth hooks cover its server-invoked operations, not client requests

- Status: Accepted
- Date: 2026-07-23
- Builds on: [ADR-0010](0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md) (domain-layer
  before/after hooks), [ADR-0015](0015-bearer-assertions-are-signed-or-sealed.md) (signed vs sealed)
- Origin: a `/grilling` session giving `@super-line/plugin-auth` a host-extension seam (see
  `PLAN-plugin-auth-hooks.md`)

## Context

ADR-0010 established the reusable-plugin idiom — read-only collections, mutations as requests, and one domain
core per operation wrapped in before/after hooks so a host extension fires for a client request and an
imperative kit call alike and can never be bypassed. plugin-auth shipped with the requests-first half and **no
hooks**: no seam to hang an audit log, a policy, or an escalation guard on any auth operation.

Adding hooks, plugin-auth splits differently from chat, because its operations have two different invokers.

## Decision

**plugin-auth hooks cover its server-invoked operations** — `authenticate` (the connection identity op,
wired by the host and run by the runtime per connection) and the imperative kit (`authKit.users.*`,
`authKit.credentials.*`, `authKit.apiKeys.*`, `authKit.tokens.*`). The **client request handlers**
(`signIn`/`signUp`/`signOut`/`createApiKey`/`revokeApiKey`/`getToken`), invoked by clients over the wire, are
**not hooked.**

The line is *who invokes the operation*, and it exists because the two sides do not have the same
alternatives. Client requests **already have a veto seam**: the `use:` middleware chain sees every inbound
request by name and rejects by throwing. The server-invoked operations have **no seam at all** — `authenticate`
is a function the host passes through, and the kit methods are un-interceptable. Hooks fill the surface with
no alternative rather than duplicating the one that has middleware. (This also explains why plugin-auth does
not follow chat's "one core, two callers" guarantee: auth's kit and wire handlers are *different functions
with different authorization* — the client handler authorizes self-service against the connection's roles, the
kit is server-authoritative over an explicit `userId` — so there is no single core to share, and the wire half
is already gated.)

Two shape notes on the hooked operations:

1. **`authenticate.after` transforms and vetoes.** The kit `after` is observe-only — the write already
   committed, so mutating it would create inconsistency. `authenticate` commits nothing; it *produces* the
   connection's identity. So its `after` may return a new `AuthResultOf<C>` (enrich `ctx`, override `env`,
   change `role`) or throw to reject the connection, and its `before` may rewrite the `Handshake` or throw.
   Both directions vetoing is correct — rejecting a connection is `authenticate`'s native contract. This is
   the first-class form of the wrap a host could always write around `authKit.authenticate`; it is surfaced as
   a hook so all auth extension lives in one place (`auth({ hooks })`).

2. **One kit `before` cannot veto.** On `users.deactivate` — the emergency stop that revokes a compromised
   account cluster-wide — `before` may observe/transform, but a throw is routed to `onError` and the
   deactivation proceeds. Host code must never block incident response. This is chat's own *"cleanup must
   always run"* principle applied to a safety op.

And one property shared across the surface that chat's hooks do not have:

3. **Payloads carry raw secrets.** `authenticate.before` sees the handshake's bearer tokens
   (`query.{jwt,apiKey}`); `credentials.*.before` sees the plaintext password; `apiKeys.create.after` and
   `tokens.*.after` see the raw `slp_…` key / minted token. The footgun — `after: (r) => log(r)` writing a
   live credential to disk — is accepted for the power it buys (mirror a key into a vault, forward a token to
   an external store) and mitigated by documentation, not by redacting the hook's view (which would silently
   break the vault use case and cannot help `before` at all without killing policy checks).

Unchanged from ADR-0010: reads are unhooked; kit `after` throws propagate but the write stays; cascaded
internal revocations fire no per-op hooks (silent cascades); no initiator is carried (every hooked op is
server-invoked, so the client/server union collapses to a constant).

## Consequences

- A host gets an un-bypassable seam over every server-invoked auth operation: reject/enrich a connection at
  `authenticate`, and audit/transform/veto agent provisioning, admin user management, and key/token minting.
- The client request surface keeps its existing gate (`use:` middleware); the deliberate absence of a
  `signUp`/`signIn` hook is documented, not accidental. One consequence recorded so it is not read as a bug:
  `MiddlewareInfo` carries no request body, so a password-policy/disposable-email check on the client signup
  path has no home under this scope — a host enforces it on the hooked `authKit.credentials.create`
  provisioning path, or a single additive `signUp` hook is added later.
- plugin-auth becomes a second concrete instance of the ADR-0010 idiom, shaped for a plugin whose operations
  have two invokers — the split catalogued here so the asymmetry with chat reads as intentional.
- Additive minor (**0.7.0**): `hooks?` is optional; every existing caller is unaffected.
