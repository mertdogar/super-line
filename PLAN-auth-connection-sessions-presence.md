# PLAN — connection sessions and chat member presence

This plan redesigns `@super-line/plugin-auth` sessions around SuperLine's
realtime connection model and uses those sessions to add profile and presence
data to `@super-line/plugin-chat` member APIs. It is a deliberate breaking
change. Existing session rows and APIs do not need compatibility shims.

The central rule is that authentication methods establish connections, while a
session records one accepted authenticated connection. Email/password access
tokens, API keys, JWTs, and future authentication methods all produce the same
session shape.

## Status

The design was settled in a `/grill-me` session on July 21–22, 2026. No
implementation existed when this plan was written.

## Problem

`plugin-chat` can return live channel membership rows, but those rows contain
only `userId`, role, and membership metadata. A React client must separately
subscribe to the auth user directory to render `displayName`, and it cannot
determine whether a member is online.

The current auth data model also gives `sessions` the wrong meaning for a
realtime platform:

- `sessions` contains password bearer-token grants created before an
  authenticated socket exists.
- API-key connections create no session rows.
- JWT connections create no session rows.
- `authKit.users.create()` always creates an email credential, even for an
  API-key-only agent. The collections-chat example therefore stores an empty
  password hash for its agent.
- The database has no durable record of accepted authenticated connections,
  their owning nodes, their heartbeat freshness, or when they ended.

The redesign must make authentication strategies peers, record every accepted
authenticated connection uniformly, survive node crashes, retain connection
history, and expose only safe aggregate presence to chat clients.

## Goals

The implementation must provide these outcomes:

- Treat one session row as one accepted authenticated connection.
- Create sessions for access-token, API-key, JWT, and future auth strategies.
- Exclude anonymous guest and reserved plugin connections from auth sessions.
- Record connection ownership, authentication provenance, heartbeat freshness,
  and termination.
- Retain ended sessions indefinitely by default.
- Recover truthful online status after a client or node crashes.
- End unfinished sessions immediately when the same stable node replica boots.
- Keep raw session and credential data server-only.
- Publish a safe auth-owned user-presence projection.
- Return `displayName`, `online`, `connectedAt`, and `lastSeenAt` from
  `chat.members()` and React's `useMembers()`.
- Remove the API-key-only agent's empty email credential.
- Keep automatic browser reconnects by separating reusable access tokens from
  connection sessions.

## Non-goals

This change does not add these capabilities:

- Idle, away, busy, or application-activity status.
- Device names, IP addresses, user agents, or geolocation.
- Client access to raw session, node, transport, or credential-reference data.
- Automatic deletion, archival, or retention limits for session history.
- A JWT denylist or persistent JWT credential table.
- Backward compatibility for the old `sessions` schema or imperative auth APIs.
- Changes to resource-level "who has this document open" presence in
  `plugin-chat`.
- Replacement of the adapter presence directory used by `srv.cluster`,
  `srv.isOnline`, routing, and topology.

## Settled decisions

The implementation must follow these decisions.

1. A session represents exactly one accepted authenticated connection.
2. `session.id` and `conn.id` are the same value.
3. Every reconnect creates a new session row, even when it reuses the same
   access token or API key.
4. Sessions are append-only connection history. Ending a session updates
   `endedAt`; it never deletes the row.
5. `lastSeenAt` is the last server-confirmed client heartbeat pong.
6. The default server heartbeat remains 30 seconds, and member presence becomes
   stale after 90 seconds without a confirmed pong.
7. A graceful close sets `endedAt` immediately.
8. A stable, explicitly configured `nodeKey` identifies one replica slot across
   restarts. The existing random `nodeId` continues to identify one process
   incarnation.
9. On boot, a node ends every unfinished session that has its `nodeKey` before
   accepting authenticated clients.
10. Raw sessions stay server-only. Clients receive a safe aggregate projection.
11. The public presence visibility follows the existing public auth user
    directory. When `usersReadable` is enabled, user presence is also readable.
12. `online` is derived from timestamps. It is not stored as a durable boolean.
13. Imperative user creation creates a profile only. Credential creation is a
    separate operation.
14. Public `signUp()` remains a convenience flow that creates a user, an email
    credential, and an access token.
15. Reusable password bearer grants move from `sessions` to `accessTokens`.
16. Credential revocation terminates the active sessions established with that
    credential.
17. JWT remains optional. Every JWT connection creates a normal session and
    records its JWT `jti` as the auth reference.
18. Schema changes are intentionally breaking. Persistent installations must
    migrate or recreate their auth tables.

## Data model

The auth plugin owns seven row collections after this redesign. The existing
`passwordResets` collection remains unchanged and is omitted from the diagram
below for clarity.

```text
users ─────────────── profile and roles
  │
  ├── credentials ── email/password authentication material
  ├── apiKeys ─────── API-key authentication material
  ├── accessTokens ── reusable password-login bearer grants
  └── sessions ────── one row per authenticated connection
         │
         └── userPresence ── safe per-user projection for clients
```

### Users

`users` remains the identity and public-profile collection. Presence does not
live on this row.

```ts
interface AuthUser {
  id: string;
  displayName: string;
  roles: string[];
  createdAt: number;
  deletedAt?: number | null;
  metadata?: Record<string, unknown>;
}
```

### Credentials

`credentials` contains rows only for users who can authenticate with an email
and password or claim an email invitation.

```ts
interface AuthCredential {
  email: string;
  userId: string;
  passwordHash: string;
}
```

An invited human may still have an empty password hash until the reset/claim
flow sets a password. An API-key-only user has no credential row.

### Access tokens

`accessTokens` takes over the current `sessions` responsibility. A browser may
persist one of these bearer tokens and reuse it across socket reconnects.

```ts
interface AuthAccessToken {
  id: string; // SHA-256 hash of the raw token
  userId: string;
  createdAt: number;
  expiresAt: number;
}
```

The raw token is returned once and is never stored. The existing default
lifetime of 30 days remains. Rename the current `sessionTtlMs` auth option to
`accessTokenTtlMs` so its meaning remains honest after `sessions` changes.

### API keys

`apiKeys` remains a long-lived credential collection. Its schema does not need
presence fields.

```ts
interface AuthApiKey {
  id: string; // SHA-256 hash of the raw API key
  userId: string;
  role: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
}
```

### Sessions

`sessions` becomes the durable connection-history collection.

```ts
interface AuthSession {
  id: string; // equal to Conn.id
  userId: string;
  nodeId: string;
  nodeKey: string;
  role: string;
  transport: string;
  authMethod: string;
  authId: string | null;
  connectedAt: number;
  lastSeenAt: number;
  endedAt: number | null;
}
```

Fields have these meanings:

- `nodeId` identifies one running server process. It remains a random UUID.
- `nodeKey` identifies one configured replica slot across process restarts.
- `authMethod` initially uses `access-token`, `api-key`, or `jwt`. The schema
  remains a string so future strategies do not require a session-schema enum
  migration.
- `authId` stores a non-secret credential reference: an access-token hash, an
  API-key hash, or a JWT `jti`.
- `connectedAt` records when authentication created the connection session.
- `lastSeenAt` starts at `connectedAt` and advances only after confirmed pongs.
- `endedAt` is `null` while the owning node considers the session open. A
  graceful disconnect, credential revocation, or boot cleanup sets it.

The session schema does not store `online`. A stale or crashed session can retain
`endedAt: null`, so a durable boolean would eventually lie.

### User presence

`userPresence` is a safe, auth-owned, client-readable projection keyed by
`userId`.

```ts
interface AuthUserPresence {
  userId: string;
  connectedAt: number | null;
  lastSeenAt: number | null;
}
```

The projection contains no session IDs, node identifiers, transports,
authentication methods, or credential references. If a user has never opened
an authenticated connection, the row may be absent; clients use null timestamp
defaults.

The public derived values are:

```ts
const online =
  presence.connectedAt !== null &&
  presence.lastSeenAt !== null &&
  presence.lastSeenAt > Date.now() - presenceTimeoutMs;
```

`connectedAt` is the earliest `connectedAt` among the user's currently live
sessions. It is `null` when no live session remains. `lastSeenAt` is the newest
session heartbeat in the user's retained history.

## Server identity

The server needs stable and per-boot identities because they solve different
problems.

### `nodeId`

`nodeId` keeps its existing meaning: a random ID for one running process. The
adapter and cluster bus continue to use it for echo detection, routing, and
topology.

### `nodeKey`

Add a required stable `nodeKey` server option when auth connection sessions are
enabled.

```ts
createSuperLineServer(contract, {
  nodeKey: "chat-replica-1",
  // ...
});
```

A deployment must give every concurrently running replica a distinct stable
key. For Kubernetes, a StatefulSet ordinal is suitable. A shared service name
is not suitable because two live replicas with the same key could end each
other's sessions.

Expose `nodeKey` on `SuperLineServer` and `PluginContext`. Plugin-auth must fail
clearly during setup if it cannot obtain one.

## Authentication and connection lifecycle

The auth plugin creates sessions inside its existing asynchronous
`authenticate()` path. This provides a durable acceptance gate without changing
every transport's `onConnection` callback to be asynchronous.

### Connection acceptance

For every non-guest authentication attempt, perform these steps:

1. Verify the access token, API key, or JWT.
2. Resolve and validate the requested role.
3. Generate one connection/session ID.
4. Insert the complete session row through the server co-writer.
5. Recompute the user's safe presence projection.
6. Return the authenticated context plus the generated connection ID.
7. Construct `Conn` with that returned ID and expose the accepted socket.

If the session insert fails, authentication fails and the transport does not
accept the socket. If the transport dies after authentication but immediately
before acceptance, the inserted row receives no heartbeat and becomes offline
after the normal presence timeout.

Extend the trusted auth result with an optional connection ID. Auth providers
that do not provide one retain the server's current UUID generation behavior.

### Auth context

`AuthContext` must distinguish the connection session from the credential that
authorized it.

```ts
interface AuthContext {
  userId: string | null;
  roles: string[];
  sessionId: string | null;
  authMethod: string | null;
  authId: string | null;
}
```

For an authenticated connection, `sessionId` equals `conn.id`. For a guest, all
three auth/session fields are `null`.

### Confirmed heartbeat

Add a plugin lifecycle hook for confirmed heartbeat pongs. The server calls it
after updating `conn.lastPongAt`.

```ts
onHeartbeat?: (conn: Conn, ctx: unknown, at: number) => Awaitable<void>
```

The hook must not delay pong processing or the next wire frame. The server
observes a returned promise and routes rejection to `onError`, using a new
heartbeat lifecycle error kind or a clearly named existing lifecycle category.

Plugin-auth uses the hook to update the owning session's `lastSeenAt` and then
refresh the user-presence projection. It never advances another node's session.
The plugin tracks its pending heartbeat writes so shutdown can drain them.

### Graceful disconnect

Plugin-auth uses `onDisconnect` to set the current session's `endedAt` and final
`lastSeenAt`, then refreshes the user-presence projection. The write is
idempotent so repeated close paths cannot corrupt history.

When another live session remains, the user stays online. Closing one browser
tab or device never marks the user offline while another session is fresh.

### Graceful server shutdown

The plugin disposer runs before the server closes transports and the collection
backend. It must stop accepting new heartbeat work, drain pending session
writes, set `endedAt` on every still-open session owned by the current
`nodeId`, refresh affected user-presence rows, and return only after those
writes settle. Later per-connection close callbacks are idempotent duplicates.

This ordering prevents a clean `server.close()` from producing the same
unfinished rows as a crash.

### Node boot cleanup

Plugin setup creates a startup barrier. Before authenticated calls may complete,
plugin-auth performs these steps:

1. Find sessions with the current `nodeKey` and `endedAt: null`.
2. Set `endedAt` to the boot cleanup time without changing their historical
   `lastSeenAt`.
3. Recompute presence for every affected user.
4. Mark auth initialization ready.

`authenticate()` awaits this barrier. The cleanup therefore finishes before
the node creates new authenticated sessions with the same `nodeKey`.

### Crash behavior

A process crash cannot write `endedAt`. Its session rows remain open in history,
but their `lastSeenAt` values stop advancing. Clients derive them as offline
after 90 seconds. A later reboot with the same `nodeKey` stamps `endedAt` on the
unfinished historical rows.

The adapter presence directory remains authoritative for core cluster routing
and topology. Auth sessions provide durable product presence and history; they
do not replace adapter leases or `srv.cluster`.

## Authentication flows

All authentication strategies converge on the same session creation path after
they validate their credential.

### Email and password

`signUp()` performs this sequence:

1. Create a user profile.
2. Create the email/password credential.
3. Mint an access token.
4. Return the raw access token and identity data.
5. Let `authClient` reconnect using that access token.
6. Create a new session while authenticating the new socket.

`signIn()` verifies the credential and mints an access token. It no longer
creates a row in `sessions`.

### Access token

An access token may establish multiple sequential or concurrent connections.
Each accepted socket gets a distinct session ID. Expiry or revocation blocks
future connections.

Signing out revokes the caller's access token when the connection used one. It
does not implicitly revoke an API key or JWT. The current connection ends, and
other active sessions associated with the same revoked access token are closed.

### API key

An API-key connection records `authMethod: 'api-key'` and the hashed key ID in
`authId`. Revoking an API key closes every fresh, unended session whose
`authMethod` and `authId` match that key.

An API-key-only agent has a user profile and one or more API keys. It has no
email credential, password hash, or access-token row unless the host explicitly
adds those authentication methods later.

### JWT

JWT remains optional through `jwt: { secret, ttlMs? }`. Minted JWTs receive a
unique `jti`. A JWT-authenticated socket records `authMethod: 'jwt'` and the
`jti` in `authId`.

JWTs remain stateless and valid until their signed expiry. This change does not
add a denylist. Account deactivation still blocks new JWT connections through
the existing user lookup and closes the user's active sessions.

The JWT no longer uses the current connection session ID as a reusable `sid`
claim. Its unique `jti` identifies the JWT for connection-session provenance.

### Future strategies

A future strategy must return a user, roles, `authMethod`, and a non-secret
optional `authId`. It then uses the common connection-session creation path.
It must not add strategy-specific presence columns to users or memberships.

## Imperative auth API

User profiles and authentication material become separate management surfaces.

### User management

Change user creation to create only the public profile:

```ts
const user = await authKit.users.create({
  displayName: "Ask AI",
  roles: ["user"],
  metadata: { runtime: "agent" },
});
```

Remove `email` and `password` from `AuthUsersApi.create`. Existing profile
update, role, deactivate, and reactivate operations remain on `users`.

### Credential management

Add an imperative credential surface:

```ts
await authKit.credentials.create(user.id, {
  email: "ann@example.com",
  password: "initial-password",
});
```

The credential API owns email normalization, uniqueness checks, credential
attachment, password setup/rotation, and invitation creation when a password is
omitted. Password reset continues to resolve the user through credentials.

### Session and token management

Internal revoke flows change as follows:

- Password rotation and reset delete the user's access tokens and close the
  sessions created from them.
- API-key revocation deletes the key and closes matching active sessions.
- Account deactivation deletes access tokens, API keys, and pending reset
  tokens, then closes every active user session.
- Closing a connection updates its session; it never deletes history.

Raw session management remains server-only. A public client receives no method
to enumerate another user's sessions.

## Chat member API

The persisted `memberships` schema remains unchanged. Profile and presence are
joined in the client-facing chat store rather than written into durable
membership rows.

Define an enriched member type:

```ts
type ChatMember<C extends Contract> = MembershipRowOf<C> & {
  displayName: string;
  online: boolean;
  connectedAt: number | null;
  lastSeenAt: number | null;
};
```

Update both APIs without adding a parallel presence hook:

```ts
chat.members(channelId): ChatLiveStore<ChatMember<C>>
useMembers(channelId): ChatMember<C>[]
```

Internally, the chat store joins live membership, user, and user-presence rows
by `userId`. It preserves the current membership watcher and re-subscribe
behavior when the signed-in user's channel set changes.

If a user row is temporarily missing, the store must not invent a profile. It
may omit that malformed membership until the referenced user arrives, matching
the contract's declared membership-to-user reference.

### Time-driven expiry

A crashed session does not emit a final collection update. The framework-neutral
`ChatLiveStore` must therefore schedule a refresh at the earliest current
presence expiry. When the clock crosses that deadline, it recomputes the same
snapshot and notifies subscribers even if no row changed.

React's `useMembers()` continues to use `useSyncExternalStore`; it needs no
React-specific presence timer. The underlying chat store owns timer cleanup on
`close()` and channel changes.

## Public presence policy

The existing auth option `usersReadable` controls both profile and safe presence
visibility:

- When `usersReadable: true`, `users` and `userPresence` are client-readable.
- When `usersReadable: false`, both collections remain locked.
- Raw `sessions`, `credentials`, `accessTokens`, `apiKeys`, and
  `passwordResets` always remain locked.

This design intentionally exposes global user online timestamps wherever the
global user directory is already visible. It does not add channel-specific
presence authorization in this version.

## Breaking migration

No runtime compatibility shim is required. Persistent deployments must perform
an explicit migration or recreate their auth data.

For the collections-chat SQLite database, perform this migration:

1. Create `col_accessTokens` with the old bearer-token session shape.
2. Copy existing `col_sessions` token rows into `col_accessTokens`.
3. Recreate `col_sessions` with the connection-history schema.
4. Create `col_userPresence`.
5. Remove the empty `col_credentials` row for the API-key-only agent.
6. Update `col_meta` fingerprints through the backend's normal schema setup or
   an explicit migration statement.

The SQLite backend correctly rejects the incompatible fingerprint until the
migration happens. Do not weaken its schema-drift checks.

Postgres/PGlite and other durable backends need equivalent collection-schema
changes. In-memory backends require no data migration.

## Package changes

Implement the design in focused slices across these packages and examples.

### `@super-line/core`

- Extend the trusted auth outcome with an optional connection ID.
- Preserve the existing generated-ID fallback for custom authenticators.
- Add any type support required for `nodeKey` and heartbeat lifecycle metadata.
- Keep transport handshake credentials unchanged.

### `@super-line/server`

- Add the stable `nodeKey` option and public/plugin-context fields.
- Construct `Conn` with an authenticator-provided trusted ID when present.
- Add the confirmed-pong plugin lifecycle hook.
- Observe asynchronous heartbeat-hook errors without blocking the wire loop.
- Let plugin-auth drain pending heartbeat and session-ending writes during its
  existing awaited plugin-disposer phase.
- Keep the adapter presence directory and cluster APIs unchanged.

### `@super-line/plugin-auth`

- Add `accessTokens` and `userPresence` contract collections.
- Replace the `sessions` schema and all session-token reads/writes.
- Split profile creation from credential creation.
- Add access-token minting, validation, expiry, and revocation.
- Rename `sessionTtlMs` to `accessTokenTtlMs`.
- Create sessions during authenticated `authenticate()` calls.
- Return the session ID as the trusted connection ID.
- Add boot cleanup, heartbeat updates, graceful ending, and presence projection.
- Record auth method/reference for access-token, API-key, and JWT connections.
- Disconnect sessions when their credential is revoked.
- Add a JWT `jti` when JWT is enabled.
- Remove the old JWT `sid` claim's connection-session meaning.
- Update auth client terminology and storage documentation from session token to
  access token.

### `@super-line/plugin-chat`

- Add the enriched `ChatMember` type.
- Join memberships with users and user presence inside `chat.members()`.
- Add time-driven stale-presence refresh and cleanup to the member live store.
- Let React's existing `useMembers()` return the enriched type unchanged.
- Keep resource presence and other chat stores unchanged.

### Examples and documentation

- Update collections-chat agent provisioning to create a profile and API key
  without an email credential.
- Migrate or recreate `examples/collections-chat/collections-chat.db` as agreed.
- Update auth, chat, agent, React, presence, and multi-node examples.
- Update package READMEs and the main auth/presence/chat guides.
- Update the SuperLine skill reference after the implementation is stable.
- Add changelog entries that clearly identify the breaking auth schema and API.

## Implementation order

Use test-driven, dependency-ordered slices. Keep every slice independently
reviewable.

1. **Core and server identity.** Add `nodeKey`, trusted connection IDs, and
   tests that prove generated fallback IDs and authenticator-supplied IDs.
2. **Heartbeat lifecycle.** Add the confirmed-pong plugin hook and tests for
   delivery, isolation, and error routing.
3. **Auth schemas.** Add `accessTokens` and `userPresence`, and replace the
   session schema with compile-time schema tests.
4. **Profile/credential split.** Refactor imperative provisioning and update
   sign-up, invite, password-reset, and management tests.
5. **Access-token flow.** Move sign-in/sign-up bearer grants to
   `accessTokens`; preserve auth-client persistence and reconnect behavior.
6. **Session acceptance.** Insert one session per authenticated connection,
   reuse its ID for `Conn`, and exclude guest/reserved connections.
7. **Session lifecycle.** Wire heartbeat updates, graceful `endedAt`, startup
   cleanup, and indefinite history retention.
8. **Revocation.** Close matching sessions for access-token and API-key
   revocation, password reset/rotation, and account deactivation.
9. **JWT integration.** Add `jti`, session provenance, and JWT connection tests.
10. **Safe projection.** Maintain `userPresence`, enforce visibility parity
    with `usersReadable`, and cover multi-session aggregation.
11. **Chat client join.** Enrich `chat.members()`, add time-driven expiry, and
    update React typings and tests.
12. **Multi-node coverage.** Prove session replication, node-specific
    heartbeats, `nodeKey` boot cleanup, and multi-node/multi-session presence.
13. **Breaking migration and examples.** Update collections-chat data and all
    affected provisioning code.
14. **Documentation and final verification.** Update guides, run the full
    checks, and document the breaking release.

## Test plan

Tests must cover behavior, failure paths, and type-level API changes.

### Core and server tests

- A custom authenticator without a connection ID receives a generated UUID.
- An authenticator-provided connection ID becomes `conn.id` and the cluster
  descriptor ID.
- Duplicate trusted IDs fail without replacing an existing live connection.
- `nodeKey` is exposed consistently on the server and plugin context.
- Confirmed pongs invoke the heartbeat hook with the connection and timestamp.
- Heartbeat-hook failures reach `onError` and do not break the connection.

### Auth tests

- `users.create()` creates no credential row.
- `credentials.create()` attaches a password or invitation credential.
- `signUp()` creates a user, credential, and access token.
- `signIn()` creates an access token but no connection session on the guest
  connection.
- Access-token, API-key, and JWT sockets each create one session.
- Guest and reserved connections create no sessions.
- Reusing a credential across reconnects creates distinct session rows.
- Every session ID equals its runtime connection ID.
- A pong advances only its owning session's `lastSeenAt`.
- Graceful close sets `endedAt` and preserves history.
- One of several sessions ending does not mark the user offline.
- A stale unfinished session becomes offline after the configured timeout.
- Boot cleanup ends only unfinished sessions for the current `nodeKey`.
- Two concurrently live node keys do not end each other's sessions.
- API-key and access-token revocation close only matching sessions.
- Password reset/rotation revokes access tokens and closes their sessions.
- Deactivation closes every active user session.
- JWT sessions record `jti` without creating persistent JWT credential rows.
- `usersReadable: false` locks both users and safe presence.
- Raw auth collections remain client-inaccessible.

### Chat client and React tests

- `chat.members()` returns membership fields, `displayName`, `online`,
  `connectedAt`, and `lastSeenAt`.
- `useMembers()` exposes the same enriched type and values.
- Member profile changes rerender the member list.
- Session heartbeat changes rerender online timestamps.
- Graceful disconnect updates online status immediately.
- A stale session flips offline at the deadline without a collection event.
- Another live device keeps the member online.
- Switching channels and unmounting closes all underlying stores and timers.
- StrictMode does not leak or duplicate stores and timers.

### Example-database verification

After migration, assert these database facts:

- The human user has an email credential.
- The API-key-only agent has no credential row.
- The agent has an API-key row.
- Reusable browser bearer grants live in `col_accessTokens`.
- Accepted human and agent sockets create rows in `col_sessions`.
- Agent session rows record `authMethod: 'api-key'`.
- Closing the example records `endedAt` instead of deleting sessions.

## Verification commands

Use the repository's existing package manager and scripts. At minimum, run the
focused suites after each slice and these full checks before completion:

```bash
pnpm typecheck
pnpm test
pnpm lint
```

If the repository defines narrower package scripts, run plugin-auth,
plugin-chat, server, and affected example checks before the full suite. Use
oxlint and oxfmt where configured; do not introduce ESLint or Prettier.

## Acceptance criteria

The implementation is complete only when all of these statements are true:

- The collections-chat agent has no email credential row.
- Every authenticated socket has exactly one durable session row.
- Every reconnect creates a new session without minting a new credential.
- Sessions from all supported auth strategies use the same lifecycle.
- Session and connection IDs match.
- Heartbeats update `lastSeenAt`, closes update `endedAt`, and history remains.
- A crashed connection becomes offline without requiring a disconnect write.
- A stable node reboot ends that node key's unfinished historical sessions.
- Multiple connections and nodes aggregate to truthful user presence.
- Raw sessions remain inaccessible to clients.
- `chat.members()` and `useMembers()` directly provide profile and presence.
- React flips stale members offline even when no final backend event arrives.
- Revoked credentials cannot leave associated live sessions usable.
- Focused tests, typecheck, the full test suite, and lint all pass.

## Next steps

Implement the ordered slices above without combining unrelated refactors. After
each schema or lifecycle slice, run its focused tests before proceeding to the
next dependency. Commit implementation only after the full verification set is
green.
