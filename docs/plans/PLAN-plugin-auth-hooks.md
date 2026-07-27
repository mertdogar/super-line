# PLAN — `@super-line/plugin-auth` server-side hooks

Give plugin-auth before/after hooks over its **server-side operations** — `authenticate` (the connection
identity op) and the imperative kit (`authKit.users.*` · `credentials.*` · `apiKeys.*` · `tokens.*`) — so a
host can veto/transform/audit every server-invoked auth operation: connection admission, identity enrichment,
agent provisioning, admin user management, key/token minting. Settled in a grill-me session 2026-07-23.
Target: additive minor, plugin-auth **0.6.1 → 0.7.0**.

## The line: server-invoked operations get hooks; client requests keep middleware

ADR-0010 defined the domain-hook idiom; plugin-auth got the requests-first half and **no hooks** — nowhere to
hang an audit log, a policy, or an escalation guard. This adds them, scoped by **who invokes the operation**:

- **Server-invoked** — `authenticate` (host-wired, run by the runtime per connection) and the imperative kit
  (called by host/agent code). Neither has any interception seam today. **→ hooks.**
- **Client-invoked** — the request handlers (`signIn`/`signUp`/`signOut`/`createApiKey`/`revokeApiKey`/
  `getToken`), invoked by clients over the wire. These **already** have a veto seam: the `use:` middleware
  chain sees every request by name and rejects by throwing. **→ not hooked** (middleware covers them). → ADR-0017.

This is exactly the "server side" scope: `authenticate` + kit in, client request handlers out.

**Accepted consequence:** `MiddlewareInfo` is `{ kind, name, conn }` — no request body — so a password-policy or
disposable-email check on the client **signup wire path** has no home here. A host enforces those on its own
`authKit.credentials.create` provisioning path (which *is* hooked), or a single `signUp` hook is added later
(purely additive). `signIn` rate-limiting by IP remains doable in middleware (it has `conn`).

Disconnect logic is `createSuperLineServer({ onDisconnect })`, already typed `(conn, ctx: AuthContext, code)` —
documented in the guide, no new API.

## Settled decisions

1. **Two hook shapes.** The kit ops share `AuthOpHook<In, Out>` (`before(input)` / `after(result)`).
   `authenticate` has its own shape (below), because it transforms a `Handshake`→`AuthResult`, not a
   domain input→row.

2. **`authenticate.after` transforms and vetoes.** Unlike the kit `after` (observe-only, the write already
   committed), `authenticate.after` may **return a new `AuthResultOf<C>`** (enrich `ctx`, override `env`,
   change `role`) or **throw to reject the connection** — because that is the full power of the wrap it
   replaces, and there is no committed write to stay consistent with. `authenticate.before` likewise may
   rewrite the `Handshake` or throw. Both directions vetoing is *correct* here — rejecting a connection is
   `authenticate`'s native contract. `authKit.authenticate` applies the hook internally, so the host still
   wires `authenticate: authKit.authenticate` unchanged, and the hook fires for **every** resolution
   including guests.

3. **Kit hooks are nested to mirror `authKit`.** `hooks.apiKeys.create` wraps `authKit.apiKeys.create`.
   Unambiguous precisely because a client request of the same bare name exists but is not hooked. Each wraps
   its existing kit-method body in place — no core extraction, no behavior change. The 53 existing tests are
   the regression net.

4. **No initiator.** Every hooked op is server-invoked, so chat's `{ kind:'client' } | { kind:'server' }`
   union collapses to a constant and is omitted.

5. **Kit veto policy: 10 of 11 vetoable; `users.deactivate.before` cannot veto.** `deactivate` is the
   emergency stop for a compromised account (revokes credentials, ends sessions, kicks connections
   cluster-wide); its `before` may observe/transform, but a throw is routed to `onError` and the deactivation
   **proceeds** — host code must never block incident response. Everything else (incl. `reactivate`) aborts
   on a `before` throw. Kit `after` everywhere observes: a throw propagates but the write **stays**.

6. **Cascades are silent** (chat's `deleteChannel` precedent, verified). `users.deactivate` internally
   `flushAccessTokens` + `deleteApiKeys` + `deleteResets` + `endSessions`; `credentials.setPassword` revokes
   tokens + ends sessions. Those internal writes fire **no** `apiKeys.revoke`/`tokens.*` hooks — only the
   composite's own hook fires. A complete revocation audit hooks the composite.

7. **Raw secrets flow through hooks — documented, not type-guarded.** `authenticate.before` sees
   `handshake.query.{jwt,apiKey}` (bearer tokens); `credentials.*.before` see the **plaintext password**;
   `apiKeys.create.after` sees the **raw `slp_…` key**; `tokens.mintSigned/mintSealed.after` see the
   **JWT/JWE**. A real footgun (`after: (r) => log(r)` writes a live credential to disk) accepted knowingly for
   power (mirror a key into a vault, forward a token to an external store). Mitigated by a prominent warning in
   the `AuthHooks` JSDoc and in `docs/how-to/plugin-auth.md`, **not** by redacting the payload.

8. **Deliberately unhooked:** the client request handlers (middleware covers them); `revoke(userId)` (the
   cluster-wide admin logout — a "cleanup must always run" primitive); `pushEnv`/`resolveEnv` (`env` delivery,
   ADR-0012); all reads (`users.get/find`, `apiKeys.listFor`, `tokens.verify`). Any is additive to hook later.

## Hook inventory (12)

```ts
hooks: {
  authenticate?: { before?, after? },              // connection identity
  users:       { create?, update?, setRoles?, deactivate?, reactivate? },
  credentials: { create?, setPassword? },
  apiKeys:     { create?, revoke? },
  tokens:      { mintSigned?, mintSealed? },
}
```

| Hook | Wraps | In | Out | Veto |
|---|---|---|---|---|
| `authenticate` | `authKit.authenticate` | `Handshake` | `AuthResultOf<C>` | ✓ both (rejects connection) |
| `users.create` | `users.create` | `{ displayName, roles?, metadata? }` | `AuthUser` | ✓ |
| `users.update` | `users.update` | `{ id, displayName?, metadata? }` | `AuthUser` | ✓ |
| `users.setRoles` | `users.setRoles` | `{ id, roles }` | `void` | ✓ |
| `users.deactivate` | `users.deactivate` | `{ id }` | `void` | `before` → `onError`, proceeds |
| `users.reactivate` | `users.reactivate` | `{ id }` | `void` | ✓ |
| `credentials.create` | `credentials.create` | `{ userId, email, password? }` | `AuthCredential` | ✓ |
| `credentials.setPassword` | `credentials.setPassword` | `{ userId, newPassword }` | `void` | ✓ |
| `apiKeys.create` | `apiKeys.create` | `{ userId, role, label, expiresInMs? }` | `ApiKeyInfo & { key }` | ✓ |
| `apiKeys.revoke` | `apiKeys.revoke` | `{ id }` | `void` | ✓ |
| `tokens.mintSigned` | `tokens.mintSigned` | `{ userId, claims?, expiresInMs? }` | `{ token, expiresAt }` | ✓ |
| `tokens.mintSealed` | `tokens.mintSealed` | `{ userId, claims?, sealed?, expiresInMs? }` | `{ token, expiresAt }` | ✓ |

## Types (sketch)

```ts
/** Kit-op hook: before may transform (return new input) or veto (throw → nothing written), EXCEPT
 *  users.deactivate where a throw routes to onError and the op proceeds. after observes (throw propagates,
 *  the write stays).
 *  ⚠️ Payloads carry RAW secrets — plaintext passwords into credentials.*.before, minted tokens/keys out of
 *  apiKeys.create / tokens.*.after. Never log a result wholesale. See docs/how-to/plugin-auth.md. */
export interface AuthOpHook<In, Out> {
  before?: (input: In) => In | undefined | void | Promise<In | undefined | void>
  after?: (result: Out) => void | Promise<void>
}

/** The connection identity op. Both directions may transform AND veto (throw → reject the connection).
 *  ⚠️ handshake.query carries bearer tokens (jwt / apiKey). */
export interface AuthenticateHook<C extends Contract> {
  before?: (handshake: Handshake) => Handshake | undefined | void | Promise<Handshake | undefined | void>
  after?: (result: AuthResultOf<C>, handshake: Handshake)
    => AuthResultOf<C> | undefined | void | Promise<AuthResultOf<C> | undefined | void>
}

export interface AuthHooks<C extends Contract> {
  authenticate?: AuthenticateHook<C>
  users?: {
    create?: AuthOpHook<CreateUserArgs, AuthUser>
    update?: AuthOpHook<UpdateUserArgs, AuthUser>
    setRoles?: AuthOpHook<SetUserRolesArgs, void>
    deactivate?: AuthOpHook<{ id: string }, void>   // before non-vetoable
    reactivate?: AuthOpHook<{ id: string }, void>
  }
  credentials?: {
    create?: AuthOpHook<CreateCredentialArgs, AuthCredential>
    setPassword?: AuthOpHook<SetPasswordArgs, void>
  }
  apiKeys?: {
    create?: AuthOpHook<CreateApiKeyArgs, ApiKeyInfo & { key: string }>
    revoke?: AuthOpHook<{ id: string }, void>
  }
  tokens?: {
    mintSigned?: AuthOpHook<MintArgs, { token: string; expiresAt: number }>
    mintSealed?: AuthOpHook<MintSealedArgs, { token: string; expiresAt: number }>
  }
}

// AuthServerOptions gains:
//   /** Before/after extensions around the server-side auth operations. ⚠️ payloads carry raw secrets. */
//   hooks?: AuthHooks<C>
```

## Phases (TDD; the 53 existing tests stay green throughout)

- **Phase 0 — seam.** Add `AuthOpHook`, `AuthenticateHook`, `AuthHooks`, `hooks?` on `AuthServerOptions`, and
  the `runHook` helper (transform/veto; swallow-to-`onError` for `users.deactivate`). No op wired. Types
  compile, tests untouched.
- **Phase 1 — authenticate.** Wrap `authKit.authenticate`. Tests: `before` rewrites/rejects a handshake;
  `after` enriches `ctx` (tenant) and overrides `env`; `after` throws → connection rejected; the hook fires
  for a guest resolution; wiring `authenticate: authKit.authenticate` is unchanged.
- **Phase 2 — users + credentials (7).** Wrap the seven kit methods. Tests: `users.create.before` transforms
  and vetoes; `setRoles.after` audits; `deactivate.before` throw → `onError`, deactivation still runs;
  cascades silent (deactivate fires no `apiKeys.revoke` hook); `credentials.setPassword.before` sees the
  plaintext (policy on the provisioning path).
- **Phase 3 — apiKeys + tokens (4).** Wrap `apiKeys.create/revoke`, `tokens.mintSigned/mintSealed`. Tests:
  `apiKeys.create.after` receives the raw key; `tokens.mintSealed.before` attaches a sealed claim; kit path
  only.
- **Phase 4 — docs + release.** `docs/how-to/plugin-auth.md` gains an "Extending auth" section (the
  server-side hooks with the raw-secrets warning; `onDisconnect` and `use:`-middleware recipes for the seams
  that already exist). Bump plugin-auth **0.7.0** + changelog. Note: `prepublishOnly` now also runs
  `scripts/check-manifest.mjs` (peer-dep release) — keep `package.json` version + any `VERSION`-style
  constant in step.

## Explicitly out of scope

- **Client-request hooks** (`signUp`/`signIn`/…). Middleware already vetoes them; their bodies are not
  middleware-visible, so password-policy on the wire path is knowingly unavailable here. A single `signUp`
  hook is a clean additive follow-up.
- Disconnect hooks — already `createSuperLineServer({ onDisconnect })`, documented in Phase 4, no new API.
- Hooking `revoke`/`pushEnv`/reads (decision 8).
- Any wire/protocol/client change — this is a server-side host-extension seam only.
