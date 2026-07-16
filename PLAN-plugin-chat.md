# PLAN — `@super-line/plugin-chat` (chat backbone)

A reusable chat backbone as a **paired plugin**: channels, membership control, messages — with
plugin-auth as a hard prerequisite. Settled in a grill-me session 2026-07-16. The headline
architectural choice: **all mutations are requests** (not policy-guarded row-writes), wrapped in
**domain-layer before/after hooks**, with collections serving as the client-read-only live sync
surface (→ ADR-0010).

## Settled decisions

1. **Scope v1.** Three collections (`channels` / `memberships` / `messages`) + membership control +
   edit/delete-own-messages + imperative server kits. OUT: typing/presence (host-land, ~30 lines),
   threads, reactions, read-state, history paging, DMs-as-a-concept (a private channel already is one).
2. **Channels are `visibility: 'public' | 'private'`.** Public = discoverable by any signed-in user,
   self-service join. Private = the channel row itself is membership-RLS'd; you're added, you don't join.
   Messages are membership-scoped in BOTH cases (public = joinable, not readable-without-joining).
   Guests see nothing (no principal → deny).
3. **Membership carries `role: 'owner' | 'member'`.** Creator becomes owner; owners manage membership
   (add/remove/setRole), rename/delete the channel, and can promote more owners. Members chat and can
   always self-leave. Two tiers only — no admin/moderator ladder in v1. Members cannot invite others,
   even to public channels (people self-join those).
4. **Any signed-in user may create channels** (becomes owner). Restriction knob (`canCreateChannel`)
   deferred — purely additive later.
5. **ALL mutations are requests** — 11 on the `shared` surface: `createChannel` `updateChannel`
   `deleteChannel` `joinChannel` `leaveChannel` `addMember` `removeMember` `setMemberRole`
   `sendMessage` `editMessage` `deleteMessage`. Collections are **client-read-only**: policies keep
   membership-scoped `read` filters, `write: () => false` everywhere; every write flows through the
   policy-free co-writer inside handlers. Buys server-authoritative ids + timestamps and hookability;
   costs optimistic sends (accepted). Guests get `UNAUTHORIZED` at runtime (auth-plugin pattern).
6. **Hooks attach at the DOMAIN layer.** One core function per operation; the request handler AND the
   imperative kit method call the same core; `hooks: { op: { before?, after? } }` wrap the core, so
   host logic (spam checks, audit, notifications) can never be bypassed. Hooks receive an
   `initiator: { kind: 'client', userId } | { kind: 'server' }`. `before` may transform (return) or
   veto (throw → nothing written); `after` observes (throw → error propagates but the write stays —
   documented, never swallowed).
7. **Messages hard-delete.** No `deletedAt`/tombstones; a host wanting an audit trail archives in a
   `before deleteMessage` hook. `editMessage` may change `content`/`metadata` and stamps `editedAt`
   (server clock).
8. **Schemas** (server-generated ids + timestamps; `metadata: z.record(z.string(), z.unknown()).optional()`
   on ALL THREE):
   - `channels    { id, name, visibility, createdBy: string | null, createdAt, metadata? }` — `name`
     NOT unique (enforce via `before createChannel` hook if wanted); `createdBy: null` = server-created.
   - `memberships { id: '${channelId}:${userId}', channelId, userId, role, addedBy: string | null, createdAt, metadata? }`
     — composite pk makes duplicate membership structurally impossible; `addedBy: null` = self-join/server.
   - `messages    { id, channelId, authorId, content, createdAt, editedAt: number | null, metadata? }`
   - FK `references`: memberships → users+channels, messages → users+channels (advisory, as ever).
   - **The message body is HOST-PARAMETRIZED**: `chatContract({ content?: ZodSchema })` is generic over
     the body schema (default `z.string()` = plain text). The host's schema slots into the `messages`
     collection def AND the `sendMessage`/`editMessage` request inputs at fragment construction, so the
     server validates every body and `RowOf`/`chatClient.send` infer it end-to-end. `chat()` server kit
     and `chatClient` stay non-generic — content is opaque to them (carried through, never inspected).
     The narrow, one-slot version of the generic schema-extension we ruled out. Caveats: the fragment
     is constructed once in the shared contract module (already the pattern); IR filtering/search over
     a structured body is limited — hosts wanting text search keep a searchable string in their shape.
9. **plugin-auth grows an imperative management surface** (Phase 0, in plugin-auth itself):
   - `authKit.users`: `get(id)` · `find({ filter?, limit?, offset?, includeDeactivated? })` (raw IR
     filter passthrough) · `update(id, { displayName?, metadata? })` · `setRoles(id, roles)` (validated
     against contract roles) · `create({ email, password?, displayName, roles?, metadata? })`
     (passwordless create = invite flow via existing `passwordResets`) · `deactivate(id)` ·
     `reactivate(id)` · `setPassword(id, newPassword)` (flushes sessions).
   - `authKit.apiKeys`: `create(userId, { role, label, expiresInMs? })` (raw `slp_` returned once) ·
     `listFor(userId)` · `revoke(id)` — the server-side counterpart of the client requests, needed to
     provision AI-agent users.
   - `users` row gains optional `metadata` (backward-compatible).
10. **Users soft-delete (deactivate/reactivate), never hard-delete in v1.** `deactivate` stamps
    `deletedAt` (optional field — old rows stay valid), flushes sessions + kicks connections (reuses
    `revoke`), deletes API keys; the `credentials` row STAYS (email reserved, `signIn` →
    `UNAUTHORIZED`). `authenticate` checks `deletedAt` on all three paths (session/JWT/apiKey) →
    degrades to guest. The public directory keeps serving the row so old messages render authors
    forever; clients badge deactivated users. NO chat cascade needed — memberships/messages untouched.
    True erasure (GDPR) deferred; `delete` name reserved for it.
11. **Last-owner protection.** `leaveChannel` / `removeMember` / `setMemberRole`(demote) throw
    `CONFLICT` if the channel would keep members but zero owners — promote first or delete the
    channel. No auto-promotion, no orphans. (`chatKit` can repair any state server-side.)
    Review-hardened (Phase 1): demotion uses its own predicate (the demoted target REMAINS a member,
    so demoting the last owner is blocked even in a sole-member channel); all channel/membership/send
    mutations serialize through a per-channel in-process lock (the store has no CAS — closes every
    single-node check-then-act race incl. concurrent co-owner leaves and join/send racing the
    deleteChannel cascade); `removeMember` disconnects the kicked user cluster-wide (captured read
    filters are only re-evaluated on re-subscribe, so a kick must cut live subscriptions); the guest
    deny in read policies keys on `ctx.userId` (NOT `principal`, which the runtime falls back to a
    conn-id string). KNOWN v1 caveat: under relay clustering, requests on OTHER nodes still interleave
    (e.g. join vs addMember committing the same membership pk with different roles) — no cross-node CAS.
12. **`chatKit` imperative surface** (grouped namespaces, all through the hooked domain cores,
    `initiator.kind === 'server'`):
    - `channels`: `create({ name, visibility, owner?, metadata? })` (owner given → owner-membership
      written atomically; same core the client request uses) · `get` · `find` · `update(id, { name?, metadata? })` ·
      `delete(id)` (cascades memberships + messages)
    - `members`: `add(channelId, userId, { role? })` · `remove` · `setRole` · `of(channelId)` · `channelsOf(userId)`
    - `messages`: `send({ channelId, authorId, content, metadata? })` · `edit(id, { content?, metadata? })` ·
      `delete(id)` · `find({ filter?, orderBy?, limit?, offset? })`
    - Reads included so hosts never need collection names; `srv.collection(…)` stays the escape hatch.
    - Imperative calls require the server to exist (co-writer binds at plugin setup) — document; throw
      honestly if called before.
13. **AI agents are regular users.** Provision via `users.create` (no password) + `apiKeys.create`;
    they connect with `?apiKey=` and use the same `chatClient`. No system-message concept —
    `messages.send` always takes an explicit real `authorId`.
14. **Client half = raw core-client wrapper, NO TanStack dependency.** `chatClient(client)` →
    typed request methods + small `subscribe`/`getSnapshot` live stores: `channels`,
    `members(channelId)`, `messages(channelId, { limit? })` (orderBy `createdAt asc`, default limit
    ~200 live window). It owns THE re-subscribe mechanic internally: one stable own-memberships
    subscription; membership change → tear down + re-open channels/messages subs (read filters are
    captured at subscribe time). `/react` wraps via `useSyncExternalStore`: `useChannels` /
    `useMembers` / `useMessages`. TanStack joins remain a host-side recipe (docs). Optional
    `/tanstack` subpath deferred.
15. **Packaging mirrors plugin-auth.** `@super-line/plugin-chat`, subpaths `.` (fragment
    `chatContract({ content? })` + schemas/types) · `/server` (`chat({ contract, hooks? })` — no
    `collections` option: every read/write flows through the plugin co-writer →
    `chatKit`) · `/client` · `/react`. **plugin-auth is a peer dependency** (hard prerequisite):
    handlers read `connCtx as AuthContext`; `chat()` throws at startup if the contract lacks the
    auth+chat fragments. Collection names UNPREFIXED (`channels`/`memberships`/`messages`) — collision
    with a host collection is a loud `defineContract` throw; consistency with auth's `users`/`sessions`.
16. **Validation & paper trail.** Rewrite `examples/collections-chat` onto the plugin as the
    showcase-of-everything (hand-rolled policies/handlers/seeding collapse into the two kits;
    typing/presence stay host-land to show garnish still composes). The example ships a **live LLM
    agent**: provisioned at server start via decision 13 (idempotent passwordless `users.create` +
    `apiKeys.create`, key kept locally — raw key is returned once), running as a genuine `chatClient`
    over the real WS transport with `?apiKey=`, member of a seeded `#ask-ai` channel, replying to
    human messages there — the living proof of human↔agent chat over the same contract. LLM via the
    Anthropic SDK (`ANTHROPIC_API_KEY`); with no key it degrades to a deterministic canned responder
    so the example runs offline. New
    **ADR-0010: plugin domain surfaces are requests-first with domain hooks** — records the deliberate
    reversal of the example's "optimistic row-writes, no requests" philosophy for reusable plugin
    surfaces. Docs guide page + skill update per Diátaxis; typedoc regenerates.

## Phases (TDD throughout; integration tests mirror `auth.integration.test.ts`, fast/loopback lane)

### Phase 0 — plugin-auth improvements
`users` management + `apiKeys` imperative surface + soft-delete (deactivate/reactivate + authenticate
checks) + `metadata` on users (decisions 9–10). Version bump: minor (additive) — schema field optional.

### Phase 1 — chat plugin core
Package scaffold (subpaths) · `chatContract()` fragment (collections + 11 shared requests) · `/server`
kit: domain cores + hooks + policies (read-RLS, write-deny) + request handlers + imperative namespaces
(decisions 2–8, 11–13). Startup validation (auth fragment present, contract roles).

### Phase 2 — client halves + example + docs
`/client` (`chatClient`, re-subscribe mechanic, live stores) + `/react` hooks (decision 14) ·
rewrite `examples/collections-chat` · **LLM agent in the example** (`#ask-ai` channel: server-side
provisioning, headless `chatClient` agent process, Anthropic SDK with offline fallback — decision 16) ·
ADR-0010 · docs guide + skill + README (decision 16). Publish only after ASK (repo rule).
