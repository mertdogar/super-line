# ADR-0020: Auth owns the client, so it owns the session lifecycle and the React surface

- Status: Accepted
- Date: 2026-07-25 — settled in a design session against the first real downstream consumer (Omma's `designer-core`); implementation lands in the same pass
- Supersedes: decision **D5** of `docs/plans/PLAN-plugin-auth-server-minted-tokens.md` ("No `refresh`. … Account-switch = reconstruct the helper (cheap)")
- Plan: `docs/plans/PLAN-plugin-auth-server-minted-tokens.md` (D3 `resolveToken`, D4 non-null client, D5 no-refresh)

## Context

`authClient`/`createAuth` is a **connection-lifecycle machine driven by identity**. super-line freezes
role *and* credential at connect, so it has exactly one move: build a new connection and swap. `signIn`,
`signOut` and boot are three hardcoded *causes* for that move. There is no generic one.

D5 declined to add one, on the grounds that an account switch could just **reconstruct the helper**.
That escape hatch does not exist for the binding consumers actually use: `createAuth` builds its
`authClient` eagerly and bakes the instance into both `createContext(instance)` and the provider value,
so nothing remounts it. The first real sealed-only consumer confirmed the gap in its own source:

> `createAuth` has no in-place re-mint (ADR 0057 — adopted as-shipped, no `refresh()`), so a new account
> is a NEW binding: `<AuthedSession>` is keyed on the auth signature and **the editor re-boots for the
> new account**.

A design-canvas re-boot per account switch is the cost of a missing method. Two further defects surfaced
while scoping it:

- **`signOut` is a one-way door under `resolveToken`.** It drops to guest and never re-consults the
  source, so a sealed app has no path from authed-as-A back to authed-as-B at all.
- **Boot races `signIn` and silently loses.** Boot's `resolveToken().then(...)` swaps unconditionally,
  with no check that `current` is still the client it started from, while the guest client is live and
  `signIn` is callable throughout. A slow mint that lands after the user signs in overwrites their
  session with the boot token.

Separately, the library ships **two React bindings that do not compose**. `createSuperLineHooks`
(`@super-line/react`) needs a client fed in as a prop and throws without one; `createAuth`
(`plugin-auth/react`) *owns* the client and swaps it. Every authed app writes the bridge by hand — and
the cost is measurable in the consumer's source, which reimplements `useEvent` line-for-line (same
handler-ref trick) because `useClient()` throws and its client is null until authed, plus a `whenClientReady`
passthrough, a hand-rolled null-until-authed gate, and a teardown effect.

## Decision

**Auth owns the client. Therefore it owns everything downstream of the client.** Two faces of one decision.

### 1. `resolveToken` is a credential source, not a boot hook

Reframed as [[Credential source]] (`CONTEXT.md`): the app's standing answer to *"what credential should
this client connect with?"* — `resolveToken` when set, else the persisted access token in `storage`.
Boot is merely its first consultation. `reauthenticate(): Promise<AuthState>` is a second.

One method therefore covers account switching, post-expiry re-acquisition, retry-after-rejection, and
(for a password app) revalidation — because they are all the same operation. Boot and `reauthenticate`
call **one** `transition(source)` with no branch between them.

### 2. A replacement never destroys a session it could not replace

The candidate connection is built and `whoami`-confirmed **before** the incumbent is closed, so:

| source says | outcome |
|---|---|
| a credential the server accepts | replace; `error` cleared |
| throws, or a credential the server refuses | **keep the live session**, set `error` |
| `null` | drop to guest — a deliberate "no credential", not a failure |

This is one rule, not three cases: at boot the incumbent simply *is* guest, which is why today's boot
behaviour falls out of it unchanged. A transient mint failure never costs a user their session or their
unsaved work.

### 3. `pending` on the state; one transition at a time

`AuthState` gains `pending: boolean`, orthogonal to `status: 'guest' | 'authed'`. During a switch,
`status`/`userId` keep describing the still-live incumbent and `pending` says a replacement is in flight
— so a consumer renders a spinner rather than tearing its tree down. Any transition started while
`pending` **throws `CONFLICT`**, which is also the fix for the boot-vs-`signIn` clobber above.

`status` deliberately does **not** gain a `'connecting'` member. It was chosen and then reversed in the
same session, on the grounds that a `connecting` state with a null `userId` collapses two situations
needing opposite handling — *"no session yet"* (hooks must idle) and *"a live session being replaced"*
(hooks must stay up) — which would re-create the very canvas re-boot this ADR removes.

### 4. `plugin-auth/react` is the React surface

`createAuth` is **retired**. The package exports a `<SuperLineAuthProvider>` that either builds an
`authClient` from props or adopts an existing instance (`client={…}`), plus module-level hooks typed by a
declaration-merged `Register` interface whose absence is a **hard type error** — never a silent fall back
to a loose `Contract`.

- `useAuth()` returns the **`AuthClient` instance**, not a per-render snapshot: stable identity (safe as
  a `useMemo` dep) with live `.state`/`.client` getters (no render-timing race when read inside an async
  callback), re-rendering via `useSyncExternalStore`. This is what the consumer was reaching through
  `binding.auth.*` to get.
- `useClient()` returns `Client | null` — null exactly while guest — and the data hooks
  (`useCollection`/`useDoc`/`useEvent`/`useSubscription`/`useRequest`/`useEnv`) delegate to
  `@super-line/react`, going **idle** when there is no authed client. That matches `createChatHooks`,
  which already ships null-tolerant idle semantics for the same reason.
- **Idle reads are silent; idle writes reject** `UNAUTHORIZED`. A silently-resolved write is
  indistinguishable from a successful one.
- `@super-line/react` gains a non-throwing internal accessor and a `client: T | null` provider so the
  above can delegate rather than duplicate. **`useClient()`'s public throwing contract is unchanged**, so
  standalone consumers are untouched.
- `authClient()` on `/client` is unchanged and remains the non-React entry.

Rejected: `disconnect()`/`connect()` on `AuthClient` — `SuperLineClient.close()` is terminal, so
`disconnect()` could only leave `client` a permanently-dead object or mean "swap to guest", i.e. `signOut`
without the revoke. The socket is `SuperLineClient`'s job (auto-reconnect, `connected`, `onReconnect`);
auth's job is identity. Also rejected: keeping `createAuth` alongside `Register`, because a factory
generic and a `Register` declaration can disagree while both type-check, failing at runtime as
silently-empty hooks.

## Consequences

- **Breaking, in both packages** (pre-1.0): `createAuth` is gone, `AuthState` gains `pending` and a
  non-optional `error`, and `@super-line/react`'s provider widens. Three in-repo examples, the auth docs
  and all four `skills/super-line/` files migrate with it.
- **`Register` is global augmentation.** A *package* that registers (rather than an app) leaks the
  declaration to its consumers, and a consumer with its own contract cannot override it — conflicting
  interface members are a hard error, not a shadow. The mitigation is to keep the augmentation in a
  source-only ambient file the dts build does not emit; verify this per consumer.
- **`ready` narrows to boot.** It stays a one-shot `Promise<void>` — definitionally the first time
  `pending` goes false — and is *not* re-created per transition, because a changing `ready` identity would
  break `useEffect(…, [])` consumers. Mid-life transitions are observed through `pending` and through
  `reauthenticate()`'s resolved state.
- **Non-goal: automatic re-mint across a transport reconnect.** `SuperLineClient` reconnects internally
  and never calls back out, so a dead credential rides every reconnect forever. Fixing that needs a core
  change; `reauthenticate()` is the manual hatch until then.
- **Two failure idioms remain, deliberately.** `signIn` throws (it is a *request*, and a wrong password
  is a request failure); `reauthenticate` settles into state (it is a *connect*, and boot already models
  connect failure as state, not exception). Misuse — starting a transition while one is in flight — throws
  in both.
