# PLAN — `createAuth`/`authClient` should natively support sealed (JWE) & externally-minted tokens

**Audience:** super-line / plugin-auth maintainers
**Author:** a downstream consumer (the Omma designer app), via design review
**Status:** proposal — requesting review + a go/no-go on the client-side additions
**Scope:** `packages/plugin-auth` only. All additive, all non-breaking.

> Line references are against the local checkout at time of writing (`packages/plugin-auth/src/{client,server,assertions,react}.tsx?`). Please re-anchor to HEAD before implementing.

---

## TL;DR — the ask

`createAuth`/`authClient` is currently hardwired to the **email/password → access-token** lifecycle. A **sealed-only** consumer (server-minted JWE, no password, no guest) cannot use it and is forced to hand-roll a parallel session (exactly the `JwtSession` component in `examples/react-chat-transports`).

The fix is **not** a sealed special-case and **not** a strategy framework. `authClient` is already a generic *hold-a-token, run-the-authed-connection* machine; only **credential acquisition** and a **handshake param key** are hardcoded to password. Generalize those and sealed / magic-link / OAuth-code / passkey all fall out for free — because the library never needs to know what kind of token it holds.

Concretely:

**Client (`client.ts` / `react.tsx`) — 3 options + 1 method + 1 state field, all additive:**

| Addition | Priority | One-liner |
|---|---|---|
| `getToken?: () => Promise<{ token: string } \| null>` | **must** | async credential source; generalizes the `storage.get()` restore path |
| `tokenParam?: string` (default `'token'`) | **must** | the handshake param key the token rides under |
| `guest?: boolean` (default `true`) | **must** | `false` ⇒ no guest socket; `client` is nullable via a conditional type |
| `refresh(): Promise<void>` | should | re-invoke `getToken` + reconnect (account switch / retry) |
| `AuthState.error?: { reason } \| null` | nice | first-class rejected outcome for the UI |

**Server (`server.ts`) — 1 boolean now, 2 cheap follow-ons:**

| Addition | Priority | One-liner |
|---|---|---|
| `rejectUnauthenticated?: boolean` (default `false`) | **should** | a *presented-but-invalid* credential throws instead of silently downgrading to guest |
| `auth<C, Sealed>` typed `ctx.sealed` | nice | thread `jwt.sealedClaims` output onto `AuthContext['sealed']` |
| `AssertionOptions.clientMint?: boolean` (default `true`) | nice | `false` ⇒ server can `mintSealed` without also exposing the client-facing signed `getToken` self-mint |

Every default preserves today's behavior. **All four example apps and any password/signed consumer are byte-for-byte identical if they omit the new options.**

---

## 1. Who's asking and why

The consumer is a **sealed-only** browser + agent application:

- **No email/password, no guest.** Identity comes from an upstream credential (an API key + account slug) the browser already holds.
- The **server mints a sealed JWE** from that upstream credential and returns it over a tRPC route the browser calls (the trusted mint step; the browser proves who it is with the upstream key, the server decides what to seal). This mirrors your own `examples/react-chat-transports/server.ts` `/sealed-handoff` route (`server.ts:67-83`).
- Browser **connects with `params: { jwt }`** ⇒ server stamps `authMethod: 'jwt-sealed'` ⇒ every handler refuses anything non-sealed.
- An **agent process** does the same with a server-vended token in an env var and reads the public half via `client.env`.
- **Long TTL (1 year), no refresh; revocation is explicit** (`users.deactivate`).

This is precisely the shape your `JwtSession` example demonstrates — but the example lives *beside* `useAuth()` as bespoke app code, so every sealed consumer re-implements: connect-with-`{jwt}`, `whoami`-confirm, `env.ready`, no-guest, and a readiness gate. That's the boilerplate this proposal folds into the library.

---

## 2. The design principle (why this isn't a special-case)

Walk the lifecycle of an authed connection and mark what actually varies between password and sealed:

| Stage | Password (access token) | Sealed (JWE) | Same? |
|---|---|---|---|
| Obtain the credential | `signIn({email,password})` | server mint from upstream cred | **differs** |
| Connect param key | `params: { token }` | `params: { jwt }` | **differs (one word)** |
| Confirm it stuck | `whoami()` | `whoami()` (+ `env.ready`) | ~same |
| Persist / restore | `storage` + `whoami` | same | same |
| Guest phase | starts guest, swaps | none | differs (a boolean) |
| Reconnect / swap / reactive client | the machine | the same machine | **same** |

Everything from "confirm" down is already generic. `authClient` isn't "the password lifecycle" — it's a **token-lifecycle machine with exactly one hardcoded token source**. The whole proposal is: stop hardcoding the source (`getToken`), the param key (`tokenParam`), and the guest assumption (`guest`). The library stays credential-agnostic — a token is an opaque bearer string — which is exactly what makes it extensible to future auth methods **without** an `AuthStrategy` interface.

---

## 3. Proposed client additions (detail)

### 3.1 `getToken` — the acquisition seam (**must**, non-breaking)

```ts
interface AuthClientOptions<C, R> {
  // ...
  /**
   * Async credential source. Called on boot (when no persisted token) and by refresh().
   * Return null to stay unauthenticated (e.g. a revoked subject). Default: read `storage`.
   */
  getToken?: () => Promise<{ token: string } | null>
}
```

- **Generalizes exactly one existing line:** the restore-path `const saved = storage.get()` (`client.ts:93`). Unset ⇒ behavior is byte-identical to today (reads `storage`). Set ⇒ the async source replaces it.
- **The library owns *when* it runs**, so it can `await` the first `getToken()` before resolving `ready`. This is the single most valuable property for consumers: it lets the app delete its hand-rolled "client not ready yet" deferred (our consumer currently maintains a `Deferred<Client>` purely because the client is created asynchronously). With `getToken`, `ready` settles after the first mint and downstream code is just `await auth.ready; const c = auth.client`.
- **Return shape is `{ token }` (not a bare string)** deliberately, so it can widen non-breakingly to `{ token, expiresAt? }` later if a short-TTL consumer ever needs a refresh scheduler. Ship the seam, not the scheduler (see §6).
- `null` return ⇒ drop to unauthenticated. This gives explicit revocation for free: a deactivated subject's re-mint returns `null` and the client stays down.

Consumer usage: `getToken: async () => ({ token: (await trpc.auth.mintToken.mutate()).jwt })`.

### 3.2 `tokenParam` — the handshake key (**must**, non-breaking)

```ts
tokenParam?: string // default 'token'
```

- Applied at the single `authedClient` chokepoint (`client.ts:77`):
  ```ts
  const authedClient = (token: string) =>
    options.connect({ role: options.authedRole, params: { [options.tokenParam ?? 'token']: token } })
  ```
- **Why it's mandatory for sealed:** `authenticate` dispatches a JWE only off `handshake.query.jwt` (`server.ts:308`, ⇒ `authMethod: 'jwt-sealed'`). `handshake.query.token` is the DB-looked-up access-token slot (`server.ts:334`). A JWE carried under `{ token }` fails the lookup and **silently downgrades to guest** — the sealed consumer is literally unreachable without this.
- Default `'token'` keeps every existing caller and all four examples identical. Preferred over "tell consumers to rename the key inside their own `connect`" because the persisted-restore path funnels through the same `authedClient`, so one option keeps both paths consistent automatically.

### 3.3 `guest` — the no-guest boot (**must**, non-breaking via conditional type)

```ts
guest?: boolean // default true
```

- When `false`, no guest client is ever built (`client.ts:76`/`:94`): `client` stays `null` until `getToken` yields a token, and `ready` resolves after the first `getToken` settles. Kills the throwaway guest socket a sealed-only app opens on every cold load.
- **Nullability is the one type-surface change.** Today `client` is non-null (`client.ts:33`). Scope the widening to `guest:false` via a conditional type keyed on the option, so `guest:true` (default) callers keep the non-null type and edit nothing:
  ```ts
  // sketch — exact inference mechanism is yours to choose (overload vs const-generic)
  type ClientOf<C, R, G extends boolean | undefined> =
    G extends false ? SuperLineClient<C, R> | null : SuperLineClient<C, R>
  ```
  This is the honest fix (scoped nullability) rather than a blanket widening of `client` for everyone. **Flagging as the one implementation nuance worth your judgment** — inferring the boolean literal from the options object may want an overload or a `const` param.

### 3.4 `refresh()` — imperative re-acquire (**should**, additive)

```ts
interface AuthClient<C, R> { refresh(): Promise<void> } // also surfaced on useAuth()
```

- Re-invoke `getToken` + reconnect. Replaces a consumer's "recreate the whole client when the upstream cred changes" effect (e.g. account switch): instead of tearing down and rebuilding, call `auth.refresh()`. Also the manual retry behind an error banner.
- Additive method on an interface consumers *receive* (never implement) ⇒ structurally non-breaking.

### 3.5 `AuthState.error` — a first-class rejected outcome (**nice**, additive)

```ts
interface AuthState {
  status: 'guest' | 'authed'
  error?: { reason: string } | null   // NEW
  userId: string | null
  displayName: string | null
  roles: string[]
}
```

- Today `AuthState` is flat `guest|authed` (`client.ts:6`); a bad/expired token connects as guest and every call `NOT_FOUND`s with no UI signal. An optional `error` field (set when `getToken` returns null, or — with server `rejectUnauthenticated` — when connect throws) lets the browser render a reconnect banner with `onRetry={auth.refresh}`.
- Added as an **optional field** rather than renaming the `'guest'` status literal to `'unauthenticated'`, which would silently dead-branch every existing `status === 'guest'` check. Non-breaking.

---

## 4. Proposed server additions (detail)

Strictly, **nothing on the server is required to unblock the consumer** — the gap is client-side. These are high-value cleanups.

### 4.1 `rejectUnauthenticated` (**should**, non-breaking)

```ts
interface AuthServerOptions<C> { rejectUnauthenticated?: boolean } // default false
```

- When `true`, `authenticate()` throws `UNAUTHORIZED` for a connect that **presents** a credential (`apiKey | jwt | token`) which fails to verify — bad signature, wrong alg, expired, undecryptable, deactivated subject — instead of resolving the guest ctx. A **credential-less** connect still resolves guest.
- **Biggest server win for a sealed consumer:** it lets the consumer delete the scattered per-handler `requireUserCreds`/`requirePrincipal` gates that exist *only* because `authenticate` silently downgrades a bad token to guest, and it turns a bad token into a **catchable connect error** that drives the client's `AuthState.error`/`refresh` loop — so the browser needs no `whoami`-confirm at all.
- Default `false` preserves today's downgrade-to-guest for guest-first apps.

### 4.2 Typed `ctx.sealed` via `auth<C, Sealed>` (**nice**, non-breaking)

```ts
function auth<C extends Contract, Sealed = Record<string, unknown>>(
  opts: AuthServerOptions<C> & { jwt?: AssertionOptions<Sealed> },
): AuthServer<C>
```

- Thread the Standard Schema output of `jwt.sealedClaims` onto `AuthContext<Claims, Sealed>['sealed']` so handlers read `ctx.sealed` without re-parsing. Removes a per-handler `sealedSchema.parse(ctx.sealed)` re-cast consumers repeat. Additive generic with a `Record` default ⇒ existing untyped callers unaffected.

### 4.3 `AssertionOptions.clientMint` (**nice**, non-breaking)

```ts
jwt?: { /* ...secret, ttlMs, signed, sealed, sealedClaims... */ clientMint?: boolean } // default true
```

- Answers a real rigidity: enabling `jwt` today for *server-side* `mintSealed` **also** exposes the client-facing signed `getToken` self-mint. When `clientMint:false`, the `getToken` contract handler rejects (no client can self-mint) while `authKit.tokens.mintSealed` still works server-side. Combined with `rejectUnauthenticated`, this makes "every user connection is a server-sealed connection" enforceable.

---

## 5. Before / after (the payoff for a consumer)

**After** — the consumer's entire client setup:

```tsx
const { AuthProvider, useAuth, auth } = createAuth<Contract, 'user'>({
  authedRole: 'user',
  guest: false,            // no guest socket; client is null until minted
  tokenParam: 'jwt',       // → params:{ jwt } → authMethod:'jwt-sealed'
  getToken: async () => ({ token: (await trpc.auth.mintToken.mutate()).jwt }),
  connect: ({ role, params }) =>
    createSuperLineClient(contract, { transport, role, params, crdtCollections: crdtCollectionsClient() }),
})

// Re-mint when the upstream cred changes (account switch):
useEffect(() => { void auth.refresh() }, [apiKey, accountSlug, apiBaseUrl])

// A readiness gate that was a hand-rolled Deferred<Client> becomes:
const client = (await auth.ready, auth.client)

// A failure surface the app never had:
const { state } = useAuth()
if (state.error) return <ReconnectBanner reason={state.error.reason} onRetry={auth.refresh} />
```

**Deleted from the consumer:** raw creds on the WS handshake (the upstream key now rides *only* the tRPC mint route, never the socket), an `authSignature` recreate effect, a `Deferred<Client>` readiness dance, and a bespoke `whoami`-confirm. A one-shot agent/server-side connect that never needs guest/swap/storage simply keeps calling `createSuperLineClient(..., params:{ jwt })` directly — it does **not** need the helper.

---

## 6. Non-goals — explicitly rejected as speculative generality

This design study evaluated four philosophies and adversarially critiqued each. The following were considered and **rejected**; please don't build them off the back of this request:

- **A pluggable `AuthStrategy<C,R,Input>` interface + `sealedStrategy`/`passwordStrategy` factories.** A ~7-method abstraction amortized over a single consumer running one strategy that touches ~2 of the 7 methods. `getToken` + `tokenParam` + `guest` deliver native sealed *and* future-extensibility while the library stays credential-agnostic. The tell that the "sealed is just a strategy" unification is leaky: it needs a `confirm: 'whoami' | 'env'` flag to cover browser-vs-agent.
- **A server `strategies` registry (on-socket custom credential verifiers).** Sealed consumers keep the external-cred mint **off** the socket in a tRPC/HTTP route — the upstream key never rides the handshake — so no one registers one. Zero present consumers ⇒ wait for the third occurrence.
- **`signInWithToken(token)` imperative door.** Redundant with `getToken`, which subsumes it *and* lets the library own the ready-gate (the boilerplate consumers most want gone). One acquisition seam beats two.
- **A `getToken` refresh scheduler + `reason: 'boot'|'expiry'|'reconnect'|'refresh'` union.** Serves no current consumer (1-year TTL, no refresh). `{ token }` widens to `{ token, expiresAt? }` later if a genuine short-TTL consumer appears.
- **A client-side `confirm: 'whoami'` knob.** Redundant with server `rejectUnauthenticated` for bad-token detection, and the only real consumer would immediately disable it.
- **A separate `assertionClient` / `createAssertionAuth` sibling over a shared `sessionCore`.** The lifecycle is genuinely shared, not divergent, so a second factory is unneeded. (The one sharp idea from that direction — a first-class rejected+reason outcome — is grafted as `AuthState.error`.)
- **An `authKit.tokens.mintFromExternal(...)` server helper.** A single-consumer `upsert-then-mint` composition; different consumers seal different bag shapes, so the "common" part is thin. Keep it as plain app code until a second external-identity shape stabilizes the pattern.

---

## 7. Compatibility & migration

Everything is additive with behavior-preserving defaults:

- `getToken` unset ⇒ falls back to `storage.get()` (`client.ts:93`).
- `tokenParam` defaults `'token'` (`client.ts:77`).
- `guest` defaults `true` (`client.ts:94`); nullability scoped to `guest:false` via conditional type.
- `refresh` / `AuthState.error` are additive.
- `rejectUnauthenticated` defaults `false`; `jwt.clientMint` defaults `true`; `ctx.sealed` keeps its `Record` default.

**No existing consumer or example changes.** Suggested landing order: (1) `getToken` + `tokenParam` + `guest` (unblocks sealed-only consumers); (2) `rejectUnauthenticated` (lets consumers drop per-handler gates); (3) optional typed `ctx.sealed` + `clientMint`.

---

## 8. Open questions for the team

1. **`guest:false` nullability** — do you prefer an overload, a `const`-inferred generic, or a documented `client!` at call sites? (This is the only non-mechanical bit.)
2. **`getToken` vs `signIn` coexistence** — should an app be able to use *both* (password `signIn` and a `getToken` fallback), or are they mutually exclusive per `createAuth` instance? (The consumer needs only `getToken`; flagging for your API-shape call.)
3. **`rejectUnauthenticated` granularity** — global boolean vs per-role? Global is enough for the consumer; per-role may interact with guest-first apps that still want *some* roles to downgrade.
4. **Naming** — `getToken` vs `acquire` vs `credential`; `tokenParam` vs `paramKey`. Yours to bikeshed.

---

## 9. Suggested approach for the implementing agent

- **Read first:** `packages/plugin-auth/src/client.ts` (chokepoints at `:76`, `:77`, `:93`, `:94`, `:101/103`), `react.tsx` (surface `refresh` on `useAuth`), `server.ts` (`authenticate` at `:308`/`:334`, `authMethod` at `:324`), `assertions.ts` (`AssertionOptions`, `sealedClaims`). Cross-check the current pattern in `examples/react-chat-transports/components/jwt-session.tsx` — this proposal makes that component unnecessary.
- **Land minimally:** the three client options are ~10 changed lines at existing chokepoints, not a rewrite. Resist the rejected abstractions in §6.
- **Tests:** mirror `examples/auth` — add a sealed path (server `mintSealed` → client `getToken` → connect `{ jwt }` → `whoami`), plus a "bad token + `rejectUnauthenticated` throws" case, and a compat test asserting the four examples' options-less usage is unchanged.
- **Example:** extend `examples/react-chat-transports` to demonstrate `getToken`-based sealed connect and (ideally) delete/retire the bespoke `JwtSession` in favor of the helper, as the reference for downstream consumers.
- **Housekeeping:** `pnpm build` (tsup) in `packages/plugin-auth`, add a `CHANGELOG.md` entry (`cliff.toml` is present), and run the manifest/changelog checks referenced in `package.json` `prepublishOnly`.

---

## 10. Provenance

This proposal was produced by a multi-agent design study (4 independent design philosophies → 2-lens adversarial critique each → synthesis) grounded in a full read of the plugin-auth source and a real sealed-only consumer. The rejected-ideas list in §6 is the critique output, not an afterthought — it's the part most worth heeding, because the temptation here is to over-build. If it helps, I'm happy to turn this into a PR against `packages/plugin-auth` for the client-side "must" trio.
