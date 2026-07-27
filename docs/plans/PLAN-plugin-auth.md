# PLAN — `@super-line/plugin-auth` (first-party authentication)

Proper authentication for super-line, as a **paired plugin**: email/password login, stateful
sessions, roles, (later) JWT + API keys — with all data held in typed **collections**. Settled in a
grill-me session 2026-07-06; Better Auth was evaluated and rejected (HTTP/cookie/redirect-shaped, a poor
fit for a connect-time-auth WS data bus). We build first-party instead.

## Settled decisions

1. **First-party, not Better Auth.** All chosen methods (email+password, sessions, JWT, API keys) are
   bus-friendly — none need OAuth redirects, so no second HTTP process.
2. **Session spine = stateful + JWT/API-key.** Stateful sessions (revocable, stored) are the backbone;
   JWT is an optional derived/stateless token; API keys are stateful long-lived creds. (JWT + API keys → Phase 2.)
3. **Roles are data-driven.** `roles[]` on the user row; the client declares a role in the handshake;
   `authenticate` validates `requestedRole ∈ user.roles`. Only `guest` is hardcoded. API keys carry a fixed role.
4. **All data in collections.** `users` (public, synced) · `credentials`/`sessions`/`apiKeys` (secret,
   deny-all, hash-keyed pk). Secrets are hashes-only; the inspector can read any table, so treat Control
   Center as operator-trusted.
5. **Guest + auto-reconnect.** `authenticate` returns `guest` for no/bad token; the client half hides the
   guest→user reconnect behind `signIn`/`signUp`/`signOut`, persisting the token.
6. **Extend the plugin system (type entry = contract fragment).** `defineContract({ plugins: [...] })`
   merges the plugin's collections + roles + surface INTO the contract via intersection, so `RowOf` /
   `client.collection` / per-role `Requests` all infer from the single materialized contract — proven inference,
   zero threading. Chosen over server/client generic-threading (fragile) and everything-in-contract (leaks secrets).
7. **`authenticate` owned by the plugin, wired top-level.** `authenticate: authKit.authenticate` (+ `identify`).
   ctx type flows on the proven top-level path (not threaded through the plugin tuple). `extendCtx` + a bare
   escape hatch are Phase 2 niceties.
8. **Revocation = connect-time (v1).** A revoked/expired session can't reconnect; instant kick is Phase 2.
9. **Email verify/reset = out of v1** (needs an email transport). Phase 2 via host callbacks.
10. **Crypto:** scrypt (node:crypto, zero-dep) passwords · 256-bit tokens stored as sha256 · JWT HS256 via
    `jose` on-demand (P2) · `slp_` API keys stored as sha256 (P2). Timing-safe compares.
11. **Packaging:** one package, **subpath exports** (`.` contract · `/server` · `/client` · `/react` later) —
    isolates node-crypto server code from client bundles; mirrors better-auth's layout. First subpath package in the repo.

## Phase 0 — type spike ✅ (throwaway, promoted)

Proved `defineContract({ plugins })` fragment-merge inference in isolation, then promoted into core.
Now a permanent test: `packages/core/test/plugin-contract.test.ts`.

## Phase 1 — extension + core auth + example ✅ DONE

- **core** (`packages/core/src/contract.ts`): `defineContract` overloaded with a `plugins` fragment slot;
  `ContractFragment`/`ContractPlugin`/`defineContractPlugin`/`ResolveContract`; intersection-merge return type +
  runtime merge (dup-throws on collection name / surface key). Existing callers untouched (overload 2 = identity).
- **server** (`packages/server/src/index.ts`): plugins can contribute `policies` (merged; unknown-collection /
  collision throws). `SubtractHandlers` now drops **fully-plugin-owned** blocks to optional — so a host writes
  `implement({ user, admin })`, no empty `shared: {}` / `guest: {}`.
- **`@super-line/plugin-auth`**: `authContract()` (fragment), `auth()` (server: authenticate + identify + plugin
  w/ handlers + policies + scrypt/sessions), `authClient()` (guest↔authed lifecycle + token persist). Tests:
  `packages/plugin-auth/test/auth.integration.test.ts` (5 runtime + a compile-time subtraction/ctx proof).
- **`examples/auth`**: replaced the toy hardcoded-token demo with a full showcase (sign-up / login / RLS notes /
  public directory / data-driven admin promotion / sign-out). Runs green via tsx.

## Phase 2 — extras

Auth-server features ✅ DONE (13 tests):
- **API keys** ✅ — `slp_` prefix, sha256 pk, ONE fixed role; `createApiKey`/`listApiKeys`/`revokeApiKey`;
  `authenticate` routes a `?apiKey=` handshake param (validates key role ∈ contract; requested role must match).
- **JWT** ✅ — `jose` HS256, on-demand `getToken` (15m default), enabled via `jwt: { secret }`; `authenticate`
  accepts a `?jwt=` param for stateless connect (no DB lookup). Asymmetric/JWKS later.
- **Revoke-and-kick** ✅ — `authKit.revoke(userId)` deletes the user's sessions (relay-safe co-writer) + a
  cluster-wide `toUser().disconnect()`. **No core change needed** — reused existing PluginContext capabilities.
- **Password reset** ✅ — host `sendPasswordReset({ user, token })` callback + a `passwordResets` collection;
  `requestPasswordReset` (constant response, no email-existence leak) / `confirmPasswordReset` (flushes sessions).

- **`/react`** half ✅ — `createAuth()` → `<AuthProvider>` + `useAuth()` (useSyncExternalStore); `displayName`
  threaded through the identity output + `AuthState`.
- **collections-chat → real auth** ✅ — slug-identity retired; `authContract()` merged, `authKit` wired, a
  login/sign-up screen via `/react`, presence by display name. **Browser-verified end-to-end** (sign-up →
  workspace → RLS message → sign-out → sign-in + persistence).

Remaining:
- **Email verification** — deferred (would add a required `userSchema` field / blocking-login policy).
- **DX niceties:** `extendCtx` + bare `authenticate` escape hatch; configurable guest-role name; extensible user fields.
- **Docs:** guide page (in progress) + skill update; changesets/version bumps; publish (ASK first).
