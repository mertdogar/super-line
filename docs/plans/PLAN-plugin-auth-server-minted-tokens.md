# PLAN — plugin-auth: server-minted sealed/signed connect (retire client-side minting)

**Audience:** super-line / plugin-auth maintainers
**Scope:** `packages/plugin-auth` + its two JWT-using examples + the auth docs.
**Status:** ready for implementation — decisions locked in design review.
**Supersedes/answers:** `PLAN-plugin-auth-createauth-sealed-tokens.md` (the downstream Omma proposal). This is the maintainer response: we take the proposal's *diagnosis*, apply a smaller dose, and add a decision the proposal didn't make — **retiring client-side token minting**.

> Line anchors were verified against HEAD `abb0897` (plugin-auth committed; sealed work at `785a839`). Re-anchor before editing.

---

## TL;DR

1. **Retire the client-side `getToken` request** (`Phase 0`, *breaking*). Clients can no longer self-mint. The **only** way a client obtains a bearer token is out-of-band: the server mints it (`authKit.tokens.mintSigned` / `mintSealed`) and vends it however the app likes. Both `signed` (JWS) and `sealed` (JWE) survive as server-minted **connection** credentials.
2. **Make `authClient` usable with those tokens** with three additive, non-breaking options: `tokenParam` (Phase 1), `resolveToken` + `AuthState.error` (Phase 2).
3. **Harden the server**: `rejectUnauthenticated` (Phase 1) turns a presented-but-invalid credential into a thrown `UNAUTHORIZED` instead of a silent guest downgrade.
4. **`client` stays non-null.** We declined `guest:false`/nullable-client; a sealed app boots guest-first and swaps.

Every option defaults to today's behavior. The only breaking change is Phase 0 (the `getToken` removal), whose blast radius is two examples + docs + four test files, all fixed within Phase 0 so the repo stays green.

---

## 1. Motivation & context

The driving consumer is a **sealed-only** browser + agent app (Omma): no email/password, no guest, identity from an upstream credential. Its server mints a sealed JWE from that credential over an HTTP/tRPC route; the browser connects with `params:{ jwt }` (⇒ `authMethod:'jwt-sealed'`). Today it must hand-roll a parallel session (`examples/react-chat-transports/.../jwt-session.tsx`) because `authClient` hardcodes password acquisition and the `{ token }` handshake key.

Two independent things fell out of the review:

- The **client gap** the proposal targets: `authClient` is a generic token-lifecycle machine with only *credential acquisition* + *handshake key* + *guest assumption* hardcoded. Generalize those and sealed falls out.
- A **maintainer decision** the proposal only gestured at (`clientMint:false`): kill client-side minting entirely. `getToken` being a *client* request is the exact footgun ADR-0015 (`docs/adr/0015-...:18`) flags — a client can author `claims`. Removing the request removes the footgun at the root, and inverts `ctx.claims` from *client-authored/untrusted* to *server-authored*.

---

## 2. Locked decisions (with rationale)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Scope A** — retire the client `getToken` *request*; **keep** `mintSigned` + the `signed` kind server-side. | The footgun is the *request*, not the *serialization* (ADR-0015 says so). Keeping server-side `mintSigned` preserves publicly-verifiable JWS for third-party/backend interop (the "verify with the secret, no super-line, no DB" story) at ~zero cost. Ripping out `signed` too would be a sledgehammer unwinding day-old work. |
| D2 | **`tokenParam?: string`** (default `'token'`). | The literal unblock. Server dispatches sealed off `handshake.query.jwt` (`server.ts:308`) but the access-token slot is `handshake.query.token` (`:334`); a JWE under `{ token }` fails the DB lookup and silently degrades to guest. One line at the `authedClient` chokepoint. |
| D3 | **`resolveToken?: () => Promise<{ token } \| null>`** — narrow async acquisition seam; **guest-first** (reuse the existing guest→authed swap), so `client` stays non-null. | Generalizes the single `storage.get()` restore source (`client.ts:93`) to an async one. Owns the ready-gate → deletes the consumer's `Deferred<Client>`. Guest-first (vs the proposal's `guest:false`) keeps the return type unchanged. |
| D4 | **Decline `guest:false` / nullable `client`.** | Conditional-type nullability would leak to every reader of `client`/`useAuth().client` for a modest win (skip one boot-time guest socket). For a socket-first framework one throwaway guest connect on cold-load is noise. The agent/one-shot path skips the helper entirely (`createSuperLineClient(..., params:{ jwt })`). |
| D5 | **No `refresh`.** | super-line is long-lived sockets; a token is checked once at connect and rides every reconnect in the captured handshake params. Long TTL removes the need. Account-switch = reconstruct the helper (cheap). |
| D6 | **`rejectUnauthenticated?: boolean`** (server, default `false`). | A presented-but-invalid credential should throw, not silently become guest (a footgun: the client thinks it's authed and every call `NOT_FOUND`s). Lets the app drop per-handler `require*` gates. Arguably a correctness win for everyone. |
| D7 | **`AuthState.error?: { reason } \| null`** — additive optional field. | A dead token needs a UI surface. Fed by `resolveToken` returning `null` or (with D6) the authed connect throwing. Optional field, so no existing `status==='guest'` branch changes. |
| D8 | **`clientMint` flag — dropped (moot).** | D1 makes "no client mint" permanent and unconditional; there's no flag to build. |

### Naming
- `resolveToken` (not `getToken`/`acquire`) — matches the `resolve*` house style (`resolveEnv`, `resolveIdentity`, `resolveBase`) and pairs with the server's `resolveEnv` (host-supplied async resolvers on both halves). `getToken` is poisoned (it's the request being deleted).
- `tokenParam` kept (says *what* rides there, not just "a key").

---

## 3. Rejected alternatives (do not rebuild)

- **`beforeConnect?: ({role,params}) => Promise<{role,params}>`** generic interceptor. Bundles three concerns — token acquisition (wanted), param augmentation (already covered by the app-owned `connect`), and role rewrite (breaks the binary `guest|authed` state machine). Also over-promises: `authClient` calls `connect` ~twice a session; transport reconnects happen *inside* the client and never call back out, so it can't fire there. If async *non-token* params ever appear, widen `resolveToken` to `{ token, params? }` instead.
- **`guest:false` nullable client** — D4.
- **`refresh` / a refresh scheduler / `reason` union** — D5.
- **`AuthStrategy` interface / `strategies` registry / `signInWithToken` / separate `assertionClient` factory** — all rejected in the proposal's §6; still rejected. `resolveToken` + `tokenParam` cover sealed and stay credential-agnostic.
- **Scope B (sealed-only, delete `signed`/`mintSigned`)** — D1.

---

## 4. Current state (verified chokepoints)

**Client (`packages/plugin-auth/src/client.ts`)**
- `:6` `AuthState` is flat `{ status:'guest'|'authed', userId, displayName, roles }` (no `error`).
- `:19` `AuthClientOptions` — has `authedRole`, `connect`, `storage`. No `tokenParam`/`resolveToken`/`guest`.
- `:33` `readonly client: SuperLineClient<C,R>` — **non-null**.
- `:76` `guestClient()` → `connect({ role: GUEST_ROLE, params: {} })`.
- `:77` `authedClient(token)` → `connect({ role: authedRole, params: { token } })` — **the `tokenParam` chokepoint**.
- `:93-104` restore path: `storage.get()` → `authedClient(saved)` or `guestClient()`, then `whoami()`-confirm-or-`toGuest()` — **the `resolveToken` chokepoint**.

**React (`react.tsx`)** — `:5` `AuthHookValue` re-exposes `client/state/ready/signUp/signIn/signOut`; `state` already flows through, so `AuthState.error` rides along with no new method.

**Contract (`index.ts`)**
- `:87` footgun note ("`claims` on a signed assertion is client-authored … `getToken({ claims })`").
- `:129-138` `getTokenDef` (+ the `void`-union backcompat comment at `:129-134`).
- `:160` `getToken: getTokenDef` in `authSurface`.
- `:201` `getToken: getTokenDef` in the `shared` role block of `authContract()`.

**Server (`server.ts`)**
- `:98` `jwt` option doc ("Enable bearer assertions: `getToken` issuance, …").
- `:102` `jwt?: AssertionOptions` in `AuthServerOptions` — **where `rejectUnauthenticated` is added**.
- `:280-348` `resolveBase` — the dispatch. `return guest` on credential failure at `:292/:294` (api key), `:311/:313` (jwt), `:337/:339` (access token). Credential-less/explicit-guest at `:286`, `:335`. **Where `rejectUnauthenticated` branches.**
- `:570-577` the `getToken` **handler** — **DELETE**.
- `:896-903` `authKit.tokens.mintSigned` — **KEEP** (its only remaining caller becomes the public kit).

**Assertions (`assertions.ts`)** — `:150-161` `mintSigned` impl KEEP; `:10` doc comment ("Mintable by a client (`getToken`) or the server") update.

---

## 5. Phase 0 — Retire client-side minting *(BREAKING)*

A breaking change must leave `pnpm typecheck && pnpm test && pnpm build` green, so the example migrations and doc updates ship **in the same phase/commit**.

### 5.1 Contract & server
- **`index.ts`**: delete `getTokenDef` (`:135-138`) and its backcompat comment (`:129-134`); remove `getToken` from `authSurface.clientToServer` (`:160`) and from the `shared` block of `authContract()` (`:201`).
- **`server.ts`**: delete the `getToken` handler (`:570-577`). Update the `jwt` option doc (`:98`) — it now enables `authKit.tokens.*` + stateless-assertion connect, **not** `getToken` issuance.
- **Keep** `assertions.mintSigned` (`:150`), `AuthTokensApi.mintSigned` (`:178`), `authKit.tokens.mintSigned` (`:896`), and the `mintSigned` hook (`:78`). Signed assertions remain server-mintable.
- **`index.ts:87` + `assertions.ts:10`**: rewrite the trust note. New framing: *claims are server-authored; `signed` differs from `sealed` only in that the holder can **read** signed claims but can forge neither.*

### 5.2 Docs sweep
- `docs/adr/0015-bearer-assertions-are-signed-or-sealed.md` — add a short "Update: client minting retired" note; the client-authored-claims motivation is now resolved by removal, not just by the signed/sealed split. Keep the ADR (the serialization distinction stands).
- `docs/how-to/plugin-auth.md` (`:136` "minted by: a client (`getToken`) **or** the server" → "server only"; delete the `getToken()` examples at `:146-153`; update the `ctx.claims` note at `:218`).
- `docs/tutorial-minting-sealed-tokens.md:29` — already says "no client-facing mint for sealed"; broaden: there is no client-facing mint for **either** kind now.
- `docs/explanation-auth-lifecycle-sealed-tokens.md:23` — flip "**Client-Mintable**" for the signed row to "server-minted".
- `docs/adr/0017-...:24` — drop `getToken` from the client-request enumeration.
- Regenerate typedoc-derived pages on `docs:build` (do not hand-edit `docs/reference/`).

### 5.3 Example migrations (forced — part of Phase 0)

**`examples/auth/src/main.ts`** (imperative Node demo). The `authKit` is already in scope, so the swap is one line:
```ts
// was (:219): const { jwt } = await bob.client.getToken({ claims: { workspace: 'acme' } })
const { token: jwt } = await authKit.tokens.mintSigned(bobId, { claims: { workspace: 'acme' } })
```
Downstream (`jwtVerify` offline `:224`, `params:{ jwt }` connect `:229`, session-row check) is unchanged. Rewrite the narrative (`:213-221`, comment `:54`): *"Bob mints … Bob wrote that bag himself, never authorize on it"* → *"The **server** mints a signed assertion for Bob"*, mirroring the sealed section (`:234-239`). Update `examples/auth/README.md:23,27`.

**`examples/react-chat-transports`** (browser bearer demo — the one real migration). The `TokenDialog` mints in-browser via `client.getToken()` (`token-dialog.tsx:41`), feeding three sub-demos: **verify-elsewhere** (`/api/verify`, needs a signed JWS), **handoff** (`?jwt=` → `JwtSession`), **SealedExchange** (`/sealed-handoff` trades signed→sealed).
- **Add** a small authenticated `/signed-token` route in `src/server.ts` (next to `/sealed-handoff` at `:67`) that mints via `authKit.tokens.mintSigned` — auth'd by the browser's existing access token (`Authorization: Bearer <accessToken>` or a `?token=` check against `authKit`). This is the canonical replacement: server mints, vends out-of-band.
- **Swap** `token-dialog.tsx:41` `client.getToken()` → `fetch('/signed-token')`. All three sub-demos survive unchanged (the signed token still exists, just server-vended; `/sealed-handoff` still receives a signed token to exchange).
- Reword: `mint()` comment (`:39-40`), `DialogDescription` (`:74` "minted from this session" → "issued by the server for this session"), `SealedExchange` docstring (`:212-216` "the signed token we just minted" → "just fetched"), `lib/jwt.ts:6-7`, `server.ts:91` comment, `README.md:120,138`.
- **Note:** the bespoke `JwtSession` (`jwt-session.tsx`) stays as-is in Phase 0 (still valid: connect `{ jwt }` + `whoami`-confirm). It is retired/slimmed in **Phase 2**.

### 5.4 Tests (`packages/plugin-auth/test/`)
- `assertions.integration.test.ts` — replace `user.getToken(...)` (`:118,131,135`) with `authKit.tokens.mintSigned(...)` then connect `{ jwt }`; keep the `authMethod:'jwt'` + `claims` assertions (`:126`). The `mintSigned` back-office cases (`:144,158`) are unchanged.
- `auth.integration.test.ts` — the `jwt` connect + `authMethod:'jwt'` session-row cases (`:262,270`) re-source the token from `mintSigned`; **delete** "rejects `getToken` when JWT is disabled" (`:275-281`).
- `management.integration.test.ts:208` — re-source via `mintSigned`.
- `hooks.integration.test.ts:196-208` — unchanged (already uses `authKit.tokens.mintSigned`).
- **Add** a guard test: the contract no longer exposes `getToken` (a `@ts-expect-error client.getToken()` or a runtime `NOT_FOUND`).

### 5.5 Versioning
- Breaking ⇒ minor bump under the pre-1.0 convention. Regenerate `CHANGELOG.md` (git-cliff), tag `plugin-auth-v<ver>`, run `scripts/check-manifest.mjs` (keeps peer-dep ranges + `core/src/version.ts` honest). **Do not publish** — ask first (per repo convention).

### Phase 0 checklist
- [ ] `getTokenDef` + both surface references removed; handler deleted
- [ ] `mintSigned` (impl/kit/hook) retained
- [ ] `ctx.claims` trust note rewritten (`index.ts:87`, `assertions.ts:10`, ADR-0015)
- [ ] `jwt` option doc updated (`server.ts:98`)
- [ ] `examples/auth` migrated + README + narrative
- [ ] `react-chat-transports`: `/signed-token` route + dialog swap + copy sweep
- [ ] 4 test files updated; getToken-gone guard added
- [ ] `pnpm typecheck && pnpm test && pnpm build && pnpm lint` green
- [ ] changelog + manifest check

---

## 6. Phase 1 — the unblock *(additive, non-breaking)*

### 6.1 `tokenParam` (client)
```ts
// AuthClientOptions:
/** Handshake param key the token rides under. Default 'token'. Set 'jwt' for signed/sealed connect. */
tokenParam?: string
// client.ts:77:
const authedClient = (token: string): SuperLineClient<C, R> =>
  options.connect({ role: options.authedRole, params: { [options.tokenParam ?? 'token']: token } })
```
Default `'token'` ⇒ every existing caller identical.

### 6.2 `rejectUnauthenticated` (server)
```ts
// AuthServerOptions (near :102):
/** A presented-but-invalid credential throws UNAUTHORIZED instead of degrading to guest. Default false. */
rejectUnauthenticated?: boolean
```
Implement in `resolveBase` with a small helper; a *presented* credential is implied by position (past the `if (apiKey)`/`if (jwt)`/`if (token)` guard):
```ts
const reject = (msg: string): AuthResultOf<C> => {
  if (opts.rejectUnauthenticated) throw new SuperLineError('UNAUTHORIZED', msg)
  return guest
}
```
Swap the **credential-failure** returns to `reject(...)`: `:292,:294` (api key), `:311,:313` (jwt), `:337,:339` (access token). **Leave** `:286` (explicit `role:'guest'`) and `:335` (`if (!token) return guest`, i.e. no credential presented) as plain `return guest`. Empty-string params are falsy ⇒ treated as not-presented.
- **Granularity:** global boolean (per-role deferred — speculative; interacts awkwardly with guest-first hosts).
- **Client interplay:** the client keeps its `whoami`-confirm regardless (it can't know the server's setting); `whoami()` is the first request, so it catches *both* a silent guest downgrade (`null`) and a `rejectUnauthenticated` connect throw. D6 is server-side hardening + lets the *server* drop per-handler gates — not a client-confirm removal.

### Phase 1 tests
- `tokenParam:'jwt'` routes a server-minted token to the `jwt-sealed`/`jwt` path (connect + `whoami`).
- `rejectUnauthenticated`: bad token throws `UNAUTHORIZED`; **no** credential still resolves guest; explicit `role:'guest'` still resolves guest.
- Compat: options-less `authClient`/`auth` byte-identical behavior.

---

## 7. Phase 2 — React ergonomics *(additive, `client` stays non-null)*

### 7.1 `resolveToken` semantics
```ts
// AuthClientOptions:
/** Async token source. Called once on boot; the library awaits it before `ready`. null ⇒ stay guest. */
resolveToken?: () => Promise<{ token: string } | null>
```
Rework the boot path (`client.ts:93-104`), **guest-first**:
```ts
current = guestClient()                      // sync, NON-NULL — opens one guest socket
const boot: Promise<{ token: string } | null> =
  options.resolveToken ? options.resolveToken()
  : Promise.resolve(storage.get() ? { token: storage.get()! } : null)

const ready: Promise<void> = boot
  .then(async (acquired) => {
    if (!acquired) return                     // legitimately unauthenticated → stay guest, no error
    swap(authedClient(acquired.token), { status: 'authed', /* provisional */ })
    const me = await dyn(current).whoami()    // catches silent-guest (null) AND rejectUnauthenticated throw
    if (me) setState({ status: 'authed', userId: me.userId, displayName: me.displayName, roles: me.roles })
    else { setState({ ...guestState, error: { reason: 'rejected' } }); toGuest() }
  })
  .catch((e) => { setState({ ...guestState, error: { reason: reasonOf(e) } }); toGuest() })
```
Semantics to honor (documented decisions):
- **Source precedence:** `resolveToken`, when set, replaces `storage.get()` as the boot source.
- **Persistence:** `resolveToken` results are **not** written to `storage` (the app owns re-acquisition each boot; don't silently persist a server-minted bearer token the app didn't ask to store). ⇒ split the swap so `login()`'s `storage.set` is used only on the password path. `signIn`/`signUp` unchanged.
- **Coexistence:** `resolveToken` and `signIn` may both be set (boot-acquire vs interactive) — not mutually exclusive.
- **Guest-first cost:** the guest socket opens at construction, before `resolveToken` resolves — the accepted price of D4 (non-null `client`). Invisible behind the `ready` gate.

### 7.2 `AuthState.error`
```ts
export interface AuthState {
  status: 'guest' | 'authed'
  error?: { reason: string } | null   // NEW — optional, so existing status checks are untouched
  userId: string | null
  displayName: string | null
  roles: string[]
}
```
Set on `resolveToken`→`null`-after-a-prior-token, `whoami`→`null`, or a thrown authed connect; cleared on a successful authed swap and on `signOut`.

### 7.3 React surface
No new method (D5 dropped `refresh`). `error` rides the existing `state` through `useAuth()`. Consumer: `if (state.error) return <ReconnectBanner reason={state.error.reason} />`.

### 7.4 Transports showcase
Re-cast `react-chat-transports`' bearer path onto `resolveToken` + `tokenParam` and **retire/slim `JwtSession`** — the reference implementation for downstream sealed consumers. Optional but recommended; it's the proposal's stated end-state and validates the API against a real app.

### Phase 2 tests
- `resolveToken` returns a token → `ready` resolves authed, no `Deferred`; returns `null` → stays guest, no error.
- Bad token via `resolveToken` → `error` set, dropped to guest (both with and without server `rejectUnauthenticated`).
- `client` type remains non-null (a `@ts-expect-error` asserting no `| null`).

---

## 8. Examples migration matrix

| Example | Auth usage | Phase 0 (breaking) | Phase 2 (showcase) |
|---|---|---|---|
| `examples/auth` | `authClient` + kit | **migrate**: `getToken()` → `authKit.tokens.mintSigned` + narrative | — |
| `react-chat-transports` | password `createAuth` + bearer demo | **migrate**: `/signed-token` route, dialog swap, copy | **adopt** `resolveToken`/`tokenParam`, retire `JwtSession` |
| `collections-chat` | password `createAuth` | verify typecheck/tests only | — |
| `chat-supervisor` | password `createAuth` (TUI) | verify typecheck/tests only | — |
| `chat-resources` | server `auth()` | verify typecheck/tests only | — |

The three "verify only" examples never reference `getToken`; `SubtractHandlers` drops the obligation automatically, so they compile unchanged.

---

## 9. Testing strategy (summary)

- **Fast lane** covers plugin-auth loopback integration tests (`*.integration.test.ts` are mostly loopback). Run `pnpm test` (real suite) from root — never `pnpm -r test`.
- Per phase: Phase 0 = re-source token tests + getToken-gone guard; Phase 1 = tokenParam routing + rejectUnauthenticated matrix + options-less compat; Phase 2 = resolveToken lifecycle + error + non-null-type assertion.
- Keep the sealed end-to-end shape from `examples/auth` mirrored in a test: server `mintSealed` → connect `{ jwt }` → `whoami` → `authMethod:'jwt-sealed'`.

---

## 10. Compatibility & rollout

- **Breaking:** only Phase 0 (removal of the `getToken` request). Any downstream calling `client.getToken()` must move to a server mint + out-of-band vend. Document in the changelog with the one-line migration.
- **Additive/non-breaking:** Phases 1 & 2 — every new option defaults to today's behavior; `client` stays non-null.
- **Landing order:** 0 → 1 → 2, each independently shippable. Phase 1 alone makes sealed reachable (with app-owned storage seeding); Phase 2 is the ergonomics layer.
- **Publish:** ask before `npm publish` (repo convention). Bump plugin-auth; run manifest + changelog checks.

---

## 11. Non-goals / deferred

- **`auth<C, Sealed>` typed `ctx.sealed`** — pure DX (the field already exists and is populated). Defer indefinitely.
- **`beforeConnect`, `guest:false`, `refresh`, refresh scheduler, `AuthStrategy`, strategies registry, `signInWithToken`, `assertionClient`, `mintFromExternal`** — rejected (§3).
- **Scope B (sealed-only, delete `signed`)** — rejected (D1).
- **Server-push resync on sealed reject** — out of scope (tracked with the CRDT/validate-before-commit work, not here).
