# PLAN — Connection `env` (server-vended, client-visible per-connection state)

Status: **designed, not built** · Origin: a `/grill-with-docs` session on "make bot auth easier"
(2026-07-16/17). This plan is the output of that grilling; it supersedes the framing of the ask, which
started as "bot authentication" and resolved into something narrower and cleaner.

> **Naming.** The primitive is called **`env`** — "the environment the server vended this connection."
> It was almost called `context`, but that collides head-on with `conn.ctx` (the existing per-connection
> identity from `authenticate`) — one letter apart, opposite meaning. `env` reads cleanly beside `ctx`
> (`authenticate → { role, ctx, env }`). `data` / `ctx` / `env` are the three per-connection bags (see §3).

---

## 1 · What this is (and what it is not)

**The real need.** An AI agent (a bot) and a human share a channel. The connection is orchestrated by the
server. Over the life of the conversation the agent needs **credentials + config to do its work** — an
`omma.ai` API key, a `projectId`, and other real, external secrets — so it can call other services *on the
human's behalf, out-of-band*. The server knows, per its own business logic, which creds a given connection
should hold. Today there is **no way for the server to hand a connected client a typed payload and keep it
live**.

**What we're building.** A first-class **`env`** primitive in `@super-line/core`: a **typed, per-connection,
server-owned, client-visible** state bag, seeded at connect (by `authenticate`) and updatable live. It is the
visibility-mirror sibling of the existing `conn.data` (server-only per-connection scratch). super-line is a
**pure courier**: it validates the shape against the contract and delivers it; it never interprets, acts on, or
attributes the payload.

**Explicit non-goals** (each was considered and rejected during the grilling — see §8):

- **NOT bot identity.** Bots already authenticate fine (API key → fixed role). No bot marker, no
  `kind: 'bot'`, no `authKit.bots.*`. Identity stays uniform.
- **NOT impersonation or on-behalf-of.** The agent never "becomes" the human and never acts inside super-line
  with the human's permissions. It acts as its own bot identity; the `env` creds are for *its own outbound
  calls*. There is no attribution question because super-line is not the actor.
- **NOT persisted.** The payload holds live secrets. It is **never** written to a collection or any store —
  it lives only in memory on the live connection and is re-seeded on reconnect. Secrets never touch disk.
- **NOT channel-scoped.** `env` is keyed by the **connection** (an identity on a socket), not by a chat
  channel. (We briefly modeled it per-`(channel, member)`; that was an over-fit — the key is the connection,
  the channel was only the venue. One agent connection = one conversation.)
- **NOT visible to the LLM.** The agent's *runtime* reads `env` and wires the creds into its tool
  implementations. The model in the tool loop never sees the raw payload; `chatAgentTools` adds no
  `get_env` tool. Secrets stay out of prompts, traces, and outputs.

---

## 2 · Vocabulary (feeds `CONTEXT.md`)

The grilling sharpened these terms. All belong in `CONTEXT.md` when we write it:

- **Credential** — the durable stored secret that proves identity: a password hash (`credentials` collection)
  for a human, an **API key** for a bot. Verified at login/connect.
- **Session token** — a *re-sendable substitute for a password*, issued after the credential is verified once,
  so a human's browser can reconnect without re-sending the password (and so a login can be revoked without
  changing the password). Humans only. A bot needs **none** — its API key is already a safely-re-sendable
  durable credential. `sessionId: null` for API-key connections is therefore correct, not a gap.
- **Connection session** — the live connection plus its server-side state. Every connection has one, bots
  included.
- **`ctx`** — the **frozen, server-only identity** a connection authenticated as (`{ userId, roles, sessionId }`
  in plugin-auth). Set once by `authenticate`, the trusted input to authorization. Unchanged by this plan.
- **`env`** — the new primitive: a typed, per-connection, server-vended, **client-visible**, mutable,
  ephemeral payload. Sibling to `data` (server-only). Courier, not authority. Seeded by `authenticate`
  alongside `ctx`.

---

## 3 · Architecture: one primitive, three bags

The mechanism lives in **core** (decided pre-1.0, no users, because it is *state* and belongs beside
`conn.data` — not bolted onto a plugin as a simulated-state event; see the ADR). Plugins and hosts *consume*
it.

### The three per-connection bags (this is the mental model)

`env` is **not** the same thing as `conn.ctx`, and the two cannot be merged — they sit at opposite corners of
a visibility × mutability grid:

|  | **frozen** | **mutable** |
|---|---|---|
| **server-only** | `conn.ctx` — identity, the authz input | `conn.data` — server-side scratch |
| **client-visible** | *(identity fields the client already knows)* | **`conn.env`** — creds/config for the client |

- `conn.ctx` stays server-only + frozen for two load-bearing reasons: **(1)** handlers and row policies
  authorize against it, so it must be a trusted, unchanging identity — you cannot safely authorize against a
  mutable, client-visible bag; **(2)** it's `unknown`, so hosts stash *server-only* per-connection state there
  (plugin-auth keeps `sessionId`; a host might keep an internal service token). Exposing `ctx` would leak all
  of that. So `env` cannot replace `ctx` — it's the opposite corner.
- `conn.data` already exists (`packages/server/src/conn.ts:20`): server-only mutable scratch, typed by the
  role's `data` schema, never sent to the client.
- `conn.env` is the new bag: **the same as `data`, but the client sees it** — the one-sentence model.

### The connection between `ctx` and `env` (the key decision)

They are **produced by the same hook**: `authenticate` returns **`{ role, ctx, env }`**. One connect-time call
yields the frozen server-only identity *and* seeds the initial client-visible `env`. This is why there is **no
separate `resolveContext`/`resolveEnv` server option** — it would be redundant with `authenticate` (both run
once at connect, both derive from the handshake/identity). `ctx` and `env` are paired at the source.

```
core          the env primitive: role `env` schema · conn.env/setEnv · client.env reactive reader ·
              the `env` wire frame · toUser().setEnv · authenticate returns { role, ctx, env }
                │
plugin-auth     thin convenience: an auth-kit `resolveEnv(ctx)` option (so authKit.authenticate can
                │   populate env from the resolved identity) + authKit.pushEnv(userId, …)
                │
plugin-inspector surfaces env in the Control Center (a ConnView field + an `env.set` live-feed event),
                │   masked by default with a host allow-list (see §7)
host            declares the `env` schema on its roles; supplies the business logic that computes it
```

---

## 4 · API surface (the target DX)

### 4.1 Contract — declare the shape (host, in `defineContract`)

```ts
const app = defineContract({
  roles: {
    user: {
      data: z.object({ lastSeenAt: z.number() }).partial(),   // existing: server-only
      env: z.object({                                         // NEW: client-visible
        projectId: z.string(),
        ommaApiKey: z.string(),
      }),
    },
  },
})
```

`env` is optional per role. A role without it → the connection has no env (`client.env.current` is `null`).

### 4.2 Server — seed via `authenticate`, push updates live

```ts
const srv = createSuperLineServer(app, {
  // authenticate now returns the initial env alongside role + ctx (all from one connect-time call)
  authenticate: async (handshake) => {
    const { role, ctx } = await verify(handshake)              // your identity resolution → ctx
    const env = ctx.userId
      ? await computeEnv(ctx.userId)                            // your business logic → { projectId, ommaApiKey }
      : undefined                                              // guests get none
    return { role, ctx, env }
  },
})

// live update mid-conversation (key rotation, re-scope) — no reconnect:
conn.setEnv({ projectId, ommaApiKey: rotated })                // on a live conn (node-local)
srv.toUser(botUserId).setEnv({ projectId, ommaApiKey })        // all of a user's conns (cluster-wide)
```

`conn.setEnv(value)` validates `value` against the role's `env` schema, stores it on `conn.env`, and emits an
`env` frame to the client. (Optional phase-2 convenience: `conn.patchEnv(partial)` over read-merge-set.)

### 4.3 Client — code-level reactive read (the LLM never sees this)

```ts
const client = createSuperLineClient(app, {
  role: 'user',
  params: { apiKey: BOT_API_KEY },
  transport: webSocketClientTransport({ url }),
})

await client.env.ready                            // resolves after the initial `env` frame (even if null)
const { ommaApiKey, projectId } = client.env.current   // typed as EnvOf<C,R> | null

client.env.subscribe((env) => refreshOutboundClients(env))   // live updates
```

`client.env` is a small reactive handle:
- `current: EnvOf<C,R> | null` — the latest value (getter).
- `ready: Promise<void>` — resolves once the first `env` frame arrives (kills the connect race).
- `subscribe(cb): () => void` — fires on every update; returns an unsubscribe fn.

On reconnect the handle re-seeds from the fresh `env` frame (`authenticate` re-runs); nothing is cached across
the drop.

### 4.4 React

```tsx
import { useEnv } from '@super-line/react'
const env = useEnv()   // EnvOf<C,R> | null
```

### 4.5 plugin-auth convenience (thin)

`authKit.authenticate` owns identity resolution, so it's the natural place to also compute `env` from the
resolved `ctx`:

```ts
const authKit = auth({
  contract: app,
  collections: backend,
  resolveEnv: async (ctx) => (ctx.userId ? await computeEnv(ctx.userId) : undefined),  // → included in { role, ctx, env }
})
authKit.pushEnv(userId, { projectId, ommaApiKey })    // sugar over srv.toUser(userId).setEnv
```

This is the only auth-plugin change; the primitive itself is core and works without plugin-auth (the host can
return `env` from its own `authenticate`).

### 4.6 The agent (tying it together — code-only creds)

```ts
const env = client.env
await env.ready
const tools = chatAgentTools(client, {
  // tool implementations close over the creds; the model only sees "there's a book_meeting tool"
  bookMeeting: (args) => callOmma({ apiKey: env.current.ommaApiKey, projectId: env.current.projectId, ...args }),
})
```

---

## 5 · Wire protocol

One new **server→client** frame, `env`, added to `ServerFrame` (`packages/core/src/wire.ts`, alongside `evt`
at line 125):

```ts
{ t: 'env', d: unknown }   // d = the full current env (post-validation), or null for "no env"
```

Full-value replace (state, not delta) — the payload is small and this keeps the client trivial (last-write
wins, no reconciliation). It is a distinct frame from `evt` deliberately: `env` is **state with a current
value**, not a fire-and-forget notification, and the client must be able to answer "what is my env right now?"
without having observed every past frame.

**Delivery:**
- **Initial (deterministic, no race):** `authenticate` is already awaited at accept. Its returned `env` is set
  on `conn.env` and an initial `env` frame is sent **before** the connection is considered ready. A role/
  connection with no env still gets an `env: null` frame so `client.env.ready` always resolves.
- **Updates:** `conn.setEnv` / `toUser().setEnv` emit an `env` frame to the target connection(s).
- **Cross-node:** `srv.toUser(userId).setEnv(value)` fans out over the Adapter exactly like the existing
  `toUser().disconnect()` / `toUser().emit()` (`packages/server/src/index.ts:393`, `:1400`); the node holding
  the connection applies `setEnv` locally and sends the frame. The value travels over the adapter (ephemeral).

---

## 6 · Type additions

Mirror the `data` types in `packages/core/src/contract.ts`:

```ts
// role block gains an optional `env` (contract.ts:53-56, beside `data?`)
interface RoleBlock { data?: Schema; env?: Schema; /* … */ }

// mirror DataOf (contract.ts:358-364)
export type EnvOf<C extends Contract, R extends RoleOf<C>> =
  C['roles'][R] extends { env: infer S extends Schema } ? InferOut<S> : null

export type AnyEnv<C extends Contract> = EnvOf<C, RoleOf<C>>

// AuthOutcome grows an optional `env` (core/transport.ts:49)
export type AuthOutcome = { role: string; ctx: unknown; env?: unknown; transport?: string }
```

- `Conn<Ev, Ctx, Role, Data>` gains an `Env` type param → `conn.env: Env`, `conn.setEnv(v: Env): void`.
- `SuperLineClient<C,R>` (client index.ts:95) gains `readonly env: EnvHandle<EnvOf<C,R>>`.
- `mergeSurfaces` must reject `env` the same way it rejects `data` (a role concern, not a surface concern —
  `contract.ts:238-245`, `:320-321`).

---

## 7 · Control Center visibility

The Control Center exists to debug the whole platform, and a server-vended per-connection bag is exactly the
kind of invisible state an operator must be able to inspect ("why does this agent hold the wrong project's
key?"). `env` slots into the existing inspector machinery beside `ctx`/`data` — with one twist: `env` is
credentials by nature, so it is **masked by default** (the opposite default from `ctx`/`data`, deliberately).

**Connection view.** `ConnView` (`packages/core/src/inspector.ts:51`) already carries `ctx?` and `data?`
(safe-serialized, `ctxAvailable`-gated for cross-node). Add `env?: unknown` beside them; the CC Connections
detail that already renders `ctx`/`data` renders `env` too.

**Live feed.** A new `env.set` inspector event (added to the `InspectorEvent` union at `inspector.ts:87` +
`eventPayload` at `:146`), emitted when `authenticate` seeds `env` and on every `conn.setEnv` /
`toUser().setEnv`, cluster-wide, always-on when `inspector: true` — parallel to `msg.*` / `collection.*` /
`crdt.*`. The CC live feed gains an **Env** filter bucket.

**Masking (decided: default-mask, allow-list).** Unlike `ctx`/`data` (deny-list `inspector.redact`), `env`
values are **masked by default**:
- The **shape is always shown** — declared keys + types (from the contract's `env` schema, via the existing
  `classifyContract`) and, per connection, which keys are populated (`ommaApiKey: "•••" (present)`). That
  answers most debugging questions without exposing a secret.
- **Values are masked** unless the key is in a host **allow-list**: a new inspector option
  `revealEnvKeys?: string[]` (e.g. `['projectId']`) renders those keys in clear; everything else stays `•••`.
- Applies to **both** the `ConnView.env` snapshot and the `env.set` live-feed payload.

The failure mode of forgetting to configure it is "I can't read the value," never "I leaked a credential."

---

## 8 · TDD implementation phases

Each phase is red→green, tests from the repo root (`pnpm test:fast` inner loop; `pnpm typecheck`/`lint` before
done). Fast-lane (loopback) tests cover the mechanism; one heavy test covers cross-node.

### Phase 1 — Core primitive: contract type + conn state
- **Test:** a contract declares `roles.user.env`; `EnvOf<C,'user'>` infers the shape; a role without `env`
  infers `null`. `mergeSurfaces` throws on an `env` key.
- **Build:** `env?: Schema` on the role block; `EnvOf`/`AnyEnv`; `Conn` gains the `Env` param + `env` field
  (default `null`) + `setEnv(v)` that `validateSync`s against the role's env schema and stores it.
  (`packages/core/src/contract.ts`, `packages/server/src/conn.ts`.)

### Phase 2 — Wire frame + client reader
- **Test (loopback):** server returns `env` from `authenticate`; client's `await client.env.ready` resolves
  and `client.env.current` equals the value, typed. A no-env role resolves `ready` with `current === null`.
  An invalid value (fails schema) throws server-side, never reaches the client.
- **Build:** `env` ServerFrame (`wire.ts`); `conn.setEnv` emits it; client `EnvHandle`
  (`current`/`ready`/`subscribe`) + an `env`-frame case in the client's ServerFrame handler
  (`packages/client/src/index.ts`); `SuperLineClient.env`.

### Phase 3 — Seed via `authenticate` (deterministic initial delivery)
- **Test (loopback):** the client can read `env.current` *before* issuing any request (env present at connect,
  no race); reconnect re-runs `authenticate` and re-seeds.
- **Build:** extend `AuthOutcome` with optional `env` (`core/transport.ts:49`); the server accept path sets
  `conn.env` from the return and sends the initial `env` frame (incl. `null`) before completing connect
  (`packages/server/src/index.ts:958-966`). No separate `resolveEnv` server option.

### Phase 4 — Live updates + cross-node
- **Test (loopback):** `conn.setEnv(v2)` mid-connection fires the client `subscribe` callback with `v2`.
- **Test (heavy, cross-node):** a connection on node A; `srv.toUser(u).setEnv(v)` called on node B reaches it
  and updates the client. (Model on `collections-cross-node` / `toUser().disconnect` cluster tests.)
- **Build:** `srv.toUser(id).setEnv(v)` + `srv.toConn(id).setEnv(v)` on the `ConnTarget`/`UserTarget`
  (`packages/server/src/index.ts:221`, `:393`), routed over the Adapter like `disconnect`/`emit`.

### Phase 5 — React hook
- **Test:** `useEnv()` renders `current`, re-renders on update. `useSyncExternalStore` over the `EnvHandle`
  (mirror `useResource`). (`packages/react/src/index.ts`.)

### Phase 6 — plugin-auth convenience
- **Test:** `auth({ resolveEnv })` makes `authKit.authenticate` return `{ role, ctx, env }` with `env` computed
  from `ctx`; `authKit.pushEnv(userId, v)` updates all of the user's connections; a guest gets `null`.
- **Build:** add a `resolveEnv(ctx)` option to `auth()` that `authKit.authenticate` awaits and folds into its
  return; add `authKit.pushEnv` as sugar over `toUser().setEnv`. (`packages/plugin-auth/src/server.ts`.) No new
  collection, no schema ownership in auth — the host declares the `env` shape on its own roles.

### Phase 7 — Control Center visibility
- **Test:** an inspector client sees a connection's `env` in its `ConnView`, masked per `revealEnvKeys`
  (`projectId` in clear, `ommaApiKey` → `•••`); an `env.set` event lands in the feed on `setEnv` and on the
  authenticate seed, with the same masking; the declared shape is present even when all values are masked.
- **Build:** `ConnView.env` + safe-serialize `conn.env`; the `env.set` `InspectorEvent` + `eventPayload`
  (`packages/core/src/inspector.ts`); the `revealEnvKeys` allow-list masking in the inspector plugin
  (`packages/plugin-inspector/src/index.ts`); the CC Connections-view `env` panel + live-feed **Env** filter
  (`packages/control-center`).

### Phase 8 — Docs + example
- How-to page: "Handing a connection its credentials." Update the plugin-auth how-to's "AI agents" section to
  show `resolveEnv` instead of implying creds are hard-coded. A section in `examples/collections-chat` showing
  an agent reading `client.env` and wiring `ommaApiKey` into a tool (LLM-invisible).

---

## 9 · Rejected alternatives (why the shape is what it is)

- **A bot identity marker / `authKit.bots.*`** — rejected. Identity stays uniform. A bot is a user with an API
  key; the gap was creds-delivery, not identity.
- **Store the env in a collection (`sessions` or a new one)** — rejected. `sessions` is the login-credential
  store (token-hash keyed, deny-all, humans-only); reusing it means changing its key, RLS, and inventing rows
  for bots. A collection also **persists** (secrets at rest) and is **member-readable** (leaks to other members).
  `env` must be ephemeral and per-connection.
- **On-behalf-of / impersonation authority** — rejected. super-line does not act for anyone; it delivers a
  payload. The agent uses the creds itself, outbound. No `initiator` growth, no principal-switching in the ACL
  core, no attribution model.
- **Per-`(channel, member)` scoping in plugin-chat** — rejected as an over-fit. The key is the connection, not
  the channel; a per-connection primitive is more general (works for channel-less workers) and correctly homed.
- **Plugin-auth-only, via a server→client event** — rejected once the "don't touch core" constraint was lifted
  (pre-1.0, no users). `env` is *state* with a current value; modeling it as an event forces re-implementing
  "hold latest + seed-on-connect + ready" by hand — a simulated-state anti-pattern that is *more* code, not
  less. Core `env` matches the grain and gives those for free. See the ADR.
- **Merging `env` into `ctx`, or dropping `ctx`** — rejected. `ctx` is server-only + frozen (the authz input,
  and the home for host server-only per-connection state); `env` is client-visible + mutable — opposite corners
  of the grid (§3). Merging would leak `ctx`'s server-only contents to the client and make authz key on a
  mutable bag. They are instead **paired at the source**: `authenticate → { role, ctx, env }`.
- **A separate `resolveEnv` core server option** — rejected as redundant with `authenticate` (both run once at
  connect from the handshake/identity). The initial `env` is a field on the authenticate return. (plugin-auth
  keeps a `resolveEnv(ctx)` *kit* option only because `authKit` owns `authenticate` for the host.)
- **LLM-visible env** — rejected. The payload holds live API keys; the runtime uses them, the model must not
  see them.

---

## 10 · Resolved during grilling

1. **Name** → **`env`** (avoids the `ctx`/`context` collision the `authenticate` return would otherwise create).
2. **Initial fill** → a field on the **`authenticate`** return (`{ role, ctx, env }`), not a separate hook.
3. **Partial updates** → ship full-value `setEnv` first; add `patchEnv` only if a real need appears.
4. **Control Center masking** → default-mask `env` values; shape always shown; host allow-lists safe keys via
   `revealEnvKeys` (opposite of `ctx`/`data`'s deny-list, because `env` always holds creds).

---

## 11 · ADR to write (on `go`)

A first-class **`env`** primitive beside `data`: client-visible, ephemeral, server-vended per-connection state,
seeded by `authenticate` alongside `ctx`; **courier, not authority**. Clears the ADR bar: hard to reverse (core
contract/wire/client surface + the `AuthOutcome` shape + the inspector `ConnView`/`env.set` surface),
surprising without context (a future reader will ask "why is `env` ephemeral, per-connection, not a collection,
not on-behalf-of, why is it separate from `ctx`, and why is it masked-by-default in the Control Center when
`ctx`/`data` are not?"), and the result of real trade-offs (core primitive vs plugin event; state vs
simulated-state-via-events; per-connection vs per-channel; courier vs authority; paired-with-`ctx` vs
merged-into-`ctx`; default-mask allow-list vs deny-list redaction). Number it after the current highest ADR
(current highest `0011` → **`0012`**).
