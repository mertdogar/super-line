import { andFilters, eq, gt, not, SuperLineError } from '@super-line/core'
import type { Contract, RoleOf, Handshake, CollectionStore, Expr, AnyEnv, EnvOf } from '@super-line/core'
import type { PluginContext, SuperLinePlugin } from '@super-line/server'
import { GUEST_ROLE } from './index.js'
import type { AuthAccessToken, AuthApiKey, AuthContext, AuthCredential, AuthPasswordReset, AuthSession, AuthSurface, AuthUser } from './index.js'
import { apiKeyToken, hashPassword, newId, randomToken, tokenHash, verifyPassword } from './crypto.js'
import { createAssertions, type AssertionOptions, type VerifiedAssertion } from './assertions.js'

export { assertionKind } from './assertions.js'
export type { AssertionKey, AssertionKind, AssertionOptions, VerifiedAssertion } from './assertions.js'

/**
 * The discriminated auth result — a member per contract role, all sharing the uniform {@link AuthContext}. Assignable
 * to the server's `AuthResult<C>` (whose per-role ctx is `unknown`), so `authenticate:` infers `A` on the proven path.
 */
type AuthResultOf<C extends Contract> = {
  // `env` is per-role, NOT the union: a role that declares no `env` schema has `EnvOf<C, R> = null`, so a
  // contract mixing env-having and env-less roles (guest never has one) stays assignable to the server's
  // own AuthResult. Using AnyEnv here would claim a guest result could carry the user role's env.
  [R in RoleOf<C>]: { role: R; ctx: AuthContext; env?: EnvOf<C, R>; connectionId?: string }
}[RoleOf<C>]

export interface AuthServerOptions<C extends Contract> {
  /** The app contract — types the resolved role and validates a requested role against the contract's roles. */
  contract: C
  /** The SAME `CollectionStore` passed to `createSuperLineServer({ collections })`; `authenticate` reads it directly. */
  collections: CollectionStore
  /** Roles granted to a newly signed-up user (must be contract roles). Default `['user']`. */
  defaultRoles?: string[]
  /** Reusable password access-token lifetime in ms. Default 30 days. */
  accessTokenTtlMs?: number
  /** Whether the `users` directory is client-readable (open read policy). Default `true`. */
  usersReadable?: boolean
  /**
   * Enable bearer assertions: `getToken` issuance, `authKit.tokens.*`, and stateless assertion connect. Omit to
   * disable all three. `{ secret }` alone is the zero-config form — HS256 signing plus an HKDF-derived `dir`
   * content-encryption key. See {@link AssertionOptions} for algorithms, JWK keys, and the payload schemas.
   */
  jwt?: AssertionOptions
  /** Deliver a password-reset token (email/SMS/…). Without it, `requestPasswordReset` is a silent no-op. */
  sendPasswordReset?: (args: { user: AuthUser; token: string }) => void | Promise<void>
  /** Password-reset token lifetime in ms. Default 1 hour. */
  passwordResetTtlMs?: number
  /**
   * Compute the connection's client-visible `env` (ADR-0012) from its resolved identity, at connect — the
   * result seeds `client.env`. Return `undefined` for none (e.g. guests). Update later with `authKit.pushEnv`.
   * Since `authKit` owns `authenticate`, this is where the host's identity-keyed env business logic lives.
   */
  resolveEnv?: (ctx: AuthContext) => AnyEnv<C> | undefined | Promise<AnyEnv<C> | undefined>
}

/** An API key's public shape — everything but the raw `slp_…` key, which only `create` ever returns. */
export interface ApiKeyInfo {
  id: string
  role: string
  label: string
  createdAt: number
  expiresAt: number | null
}

/**
 * Imperative server-side user management. Every write goes through the plugin co-writer (so changes fan
 * out to live subscribers), which binds when the server registers `authKit.plugin` — calling any of these
 * before `createSuperLineServer` throws. Users are soft-deleted only: `deactivate` stamps `deletedAt` and
 * the row keeps being served (old content keeps its author); `delete` is reserved for future true erasure.
 */
export interface AuthUsersApi {
  get(id: string): Promise<AuthUser | undefined>
  /** Snapshot the directory with a raw IR filter. Deactivated users are excluded unless `includeDeactivated`. */
  find(opts?: { filter?: Expr; limit?: number; offset?: number; includeDeactivated?: boolean }): Promise<AuthUser[]>
  /**
   * Provision a public user profile. Add an email/password credential separately when needed.
   */
  create(input: {
    displayName: string
    roles?: string[]
    metadata?: Record<string, unknown>
  }): Promise<AuthUser>
  /** Patch profile fields (displayName / metadata) and return the updated row. */
  update(id: string, patch: { displayName?: string; metadata?: Record<string, unknown> }): Promise<AuthUser>
  /** Replace the user's roles (validated against contract roles). Connect-time — live connections keep their role. */
  setRoles(id: string, roles: string[]): Promise<void>
  /** Soft-delete: stamp `deletedAt`, revoke credentials, end sessions, and kick live connections cluster-wide. */
  deactivate(id: string): Promise<void>
  /** Lift a deactivation (`deletedAt` → null), re-purging sessions/keys/resets first so nothing stale revives. */
  reactivate(id: string): Promise<void>
}

export interface AuthCredentialsApi {
  create(userId: string, input: { email: string; password?: string }): Promise<AuthCredential>
  /** Rotate a password, revoke access tokens and reset tokens, and close their active sessions. */
  setPassword(userId: string, newPassword: string): Promise<void>
}

/** Imperative API-key management — the server-side counterpart of the client requests; provisions agents. */
export interface AuthApiKeysApi {
  /** Mint a key for a user (role validated against the contract). The raw `slp_…` is returned ONCE. */
  create(userId: string, opts: { role: string; label: string; expiresInMs?: number }): Promise<ApiKeyInfo & { key: string }>
  listFor(userId: string): Promise<ApiKeyInfo[]>
  revoke(id: string): Promise<void>
}

/**
 * Server-side minting + verification of bearer assertions. Both kinds identify an existing, active user; the
 * asymmetry is deliberate (ADR-0015): a **signed** assertion is also mintable by any authenticated client via
 * `getToken`, while a **sealed** one has no client-facing mint at all, which is what makes `ctx.sealed`
 * trustworthy as server-authored data.
 */
export interface AuthTokensApi {
  /** Mint a signed assertion (JWS) — public `claims`, third-party verifiable. Roles are read from the user row. */
  mintSigned(
    userId: string,
    opts?: { claims?: unknown; expiresInMs?: number },
  ): Promise<{ token: string; expiresAt: number }>
  /** Mint a sealed assertion (JWE) — `claims` plus a `sealed` payload only this deployment can decrypt. */
  mintSealed(
    userId: string,
    opts?: { claims?: unknown; sealed?: unknown; expiresInMs?: number },
  ): Promise<{ token: string; expiresAt: number }>
  /**
   * Verify either kind and return its payloads plus the subject's CURRENT roles. `null` for anything that
   * would not authenticate: bad signature, wrong algorithm, expired, undecryptable, or a deactivated subject.
   */
  verify(token: string): Promise<VerifiedAssertion | null>
}

export interface AuthServer<C extends Contract> {
  /** Wire at the server's top-level `authenticate:` option. */
  authenticate: (handshake: Handshake) => Promise<AuthResultOf<C>>
  /** Wire at the server's `identify:` option so `principal` becomes the userId (drives collection policies/ACLs). */
  identify: (conn: { ctx: unknown }) => string | undefined
  /** Register in the server's `plugins: [...]` — the signIn/up/out/whoami handlers + open/deny-all row policies. */
  plugin: SuperLinePlugin<AuthSurface>
  /**
   * Log a user out everywhere: revoke access tokens, end active sessions, and disconnect live connections
   * cluster-wide. Use for an admin ban / "sign out of all devices". (API keys are separate — revoke those per-key.)
   */
  revoke: (userId: string) => Promise<void>
  /**
   * Update a user's client-visible `env` (ADR-0012) on all their live connections, cluster-wide (a key
   * rotated, the assignment changed). The initial value is seeded by `resolveEnv`; use this for live updates.
   */
  pushEnv: (userId: string, env: AnyEnv<C>) => void
  /** Imperative user management (get/find/create/update/roles/deactivate/…). Requires the running server. */
  users: AuthUsersApi
  /** Imperative API-key management (agent provisioning). Requires the running server. */
  apiKeys: AuthApiKeysApi
  /** Imperative email/password credential management. Requires the running server. */
  credentials: AuthCredentialsApi
  /** Mint + verify bearer assertions. Needs `auth({ jwt })`; the mints need the running server. */
  tokens: AuthTokensApi
}

const DAY_MS = 86_400_000

/** Soft-deleted? Absent/null `deletedAt` = active (legacy rows never carry the field). */
const isDeactivated = (u: AuthUser): boolean => u.deletedAt != null

/** IR filter matching only ACTIVE users: a missing field fails every range op, so legacy rows pass `not`. */
const activeOnly = (): Expr => not(gt('deletedAt', 0))

/**
 * Build the server half of the auth plugin. Pass the same `CollectionStore` the server uses. Wire the returned
 * `authenticate` + `identify` at the top level and register `plugin`:
 *
 * ```ts
 * const authKit = auth({ contract: app, collections: backend })
 * createSuperLineServer(app, {
 *   nodeKey: 'app-replica-1',
 *   collections: backend,
 *   authenticate: authKit.authenticate,
 *   identify: authKit.identify,
 *   plugins: [authKit.plugin],
 * })
 * ```
 */
export function auth<C extends Contract>(opts: AuthServerOptions<C>): AuthServer<C> {
  const { contract, collections, defaultRoles = ['user'], accessTokenTtlMs = 30 * DAY_MS, usersReadable = true } = opts
  const contractRoles = new Set(Object.keys(contract.roles))
  const assertions = createAssertions(opts.jwt)
  const sendPasswordReset = opts.sendPasswordReset
  const passwordResetTtlMs = opts.passwordResetTtlMs ?? 60 * 60_000

  const readAccessToken = (token: string) => collections.read('accessTokens', tokenHash(token)) as Promise<AuthAccessToken | undefined>
  const readUser = (id: string) => collections.read('users', id) as Promise<AuthUser | undefined>
  const readApiKey = (raw: string) => collections.read('apiKeys', tokenHash(raw)) as Promise<AuthApiKey | undefined>

  const resolveBase = async (handshake: Handshake): Promise<AuthResultOf<C>> => {
    const guest = {
      role: GUEST_ROLE,
      ctx: { userId: null, roles: [], sessionId: null, authMethod: null, authId: null },
    } as AuthResultOf<C>
    const requestedRole = handshake.query.role
    if (requestedRole === GUEST_ROLE) return guest

    // API key — a stateful long-lived credential carrying ONE fixed role. A deactivated owner disables it.
    const apiKey = handshake.query.apiKey
    if (apiKey) {
      const key = await readApiKey(apiKey)
      if (!key || (key.expiresAt !== null && key.expiresAt < Date.now())) return guest
      const owner = await readUser(key.userId)
      if (!owner || isDeactivated(owner)) return guest
      if (!contractRoles.has(key.role)) throw new SuperLineError('BAD_REQUEST', `api key role '${key.role}' is not a contract role`)
      if (requestedRole && requestedRole !== key.role)
        throw new SuperLineError('FORBIDDEN', `api key grants '${key.role}', not '${requestedRole}'`)
      return {
        role: key.role,
        ctx: { userId: key.userId, roles: [key.role], sessionId: null, authMethod: 'api-key', authId: key.id },
      } as AuthResultOf<C>
    }

    // Bearer assertion — one param carries both serializations (RFC 7519: a JWT is a claims set in JWS *or* JWE
    // form), dispatched on the compact dot count. Signature/decryption + expiry are checked statelessly; the one
    // deliberate dent is a user read (the deactivation check — PLAN-plugin-chat decision 10), which also supplies
    // a SEALED assertion's roles. A `signed` assertion keeps trusting its own role claims (ADR-0015).
    const jwtParam = handshake.query.jwt
    if (assertions && jwtParam) {
      const verified = await assertions.verify(jwtParam)
      if (!verified) return guest
      const subject = await readUser(verified.userId)
      if (!subject || isDeactivated(subject)) return guest
      const roles = verified.kind === 'sealed' ? subject.roles : verified.roles
      if (!requestedRole) throw new SuperLineError('BAD_REQUEST', 'a role is required to authenticate')
      if (!contractRoles.has(requestedRole)) throw new SuperLineError('BAD_REQUEST', `unknown role '${requestedRole}'`)
      if (!roles.includes(requestedRole)) throw new SuperLineError('FORBIDDEN', `role '${requestedRole}' not granted`)
      return {
        role: requestedRole,
        ctx: {
          userId: verified.userId,
          roles,
          sessionId: null,
          authMethod: verified.kind === 'sealed' ? 'jwt-sealed' : 'jwt',
          authId: verified.jti,
          claims: verified.claims,
          ...(verified.sealed ? { sealed: verified.sealed } : {}),
        },
      } as AuthResultOf<C>
    }

    // Access token — no token degrades to guest; an expired/absent token, vanished user, or deactivated
    // user does too (client re-logs in).
    const token = handshake.query.token
    if (!token) return guest
    const accessToken = await readAccessToken(token)
    if (!accessToken || accessToken.expiresAt < Date.now()) return guest
    const user = await readUser(accessToken.userId)
    if (!user || isDeactivated(user)) return guest
    // valid session: the requested role must be a real contract role AND granted to this user
    if (!requestedRole) throw new SuperLineError('BAD_REQUEST', 'a role is required to authenticate')
    if (!contractRoles.has(requestedRole)) throw new SuperLineError('BAD_REQUEST', `unknown role '${requestedRole}'`)
    if (!user.roles.includes(requestedRole)) throw new SuperLineError('FORBIDDEN', `role '${requestedRole}' not granted`)
    return {
      role: requestedRole,
      ctx: { userId: user.id, roles: user.roles, sessionId: null, authMethod: 'access-token', authId: accessToken.id },
    } as AuthResultOf<C>
  }

  let pluginCtx: PluginContext | undefined
  let initialization = Promise.resolve()
  let stopping = false
  const pendingWork = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    pendingWork.add(work)
    void work.then(
      () => pendingWork.delete(work),
      () => pendingWork.delete(work),
    )
    return work
  }

  // Resolve identity (above), then seed the client-visible env (ADR-0012) from it via the host's resolveEnv.
  // Tracking the whole attempt closes the shutdown race: the disposer blocks new attempts, drains accepted
  // in-flight work, then sweeps every session that work could have inserted.
  const authenticate = (handshake: Handshake): Promise<AuthResultOf<C>> => {
    if (stopping) return Promise.reject(new Error('plugin-auth is shutting down'))
    return track(
      (async () => {
        const base = await resolveBase(handshake)
        const authCtx = base.ctx as AuthContext
        if (!authCtx.userId) return base
        await initialization
        if (stopping) throw new Error('plugin-auth is shutting down')
        const ctx = pluginCtx
        if (!ctx?.nodeKey) throw new Error('plugin-auth requires createSuperLineServer({ nodeKey })')
        const now = Date.now()
        const sessionId = newId()
        await ctx.collection('sessions').insert({
          id: sessionId,
          userId: authCtx.userId,
          nodeId: ctx.nodeId,
          nodeKey: ctx.nodeKey,
          role: base.role,
          transport: handshake.transport,
          authMethod: authCtx.authMethod!,
          authId: authCtx.authId,
          connectedAt: now,
          lastSeenAt: now,
          endedAt: null,
        } satisfies AuthSession)
        await refreshPresence(authCtx.userId)
        const connectionCtx = { ...authCtx, sessionId }
        const env = opts.resolveEnv ? await opts.resolveEnv(connectionCtx) : undefined
        return {
          ...base,
          ctx: connectionCtx,
          connectionId: sessionId,
          ...(env == null ? {} : { env }),
        } as AuthResultOf<C>
      })(),
    )
  }

  const identify = (conn: { ctx: unknown }): string | undefined => (conn.ctx as AuthContext).userId ?? undefined

  // captured at startup so `revoke` (callable outside a handler) can reach the co-writer + cluster-wide kick
  const plugin: SuperLinePlugin<AuthSurface> = {
    name: 'auth',
    onEvent: (event) => {
      if (stopping || event.type !== 'collection.change' || event.n !== 'sessions' || !event.row) return
      const userId = (event.row as Partial<AuthSession>).userId
      if (userId) void track(refreshPresence(userId))
    },
    setup: (ctx) => {
      if (!ctx.nodeKey) throw new Error('plugin-auth requires createSuperLineServer({ nodeKey })')
      pluginCtx = ctx
      initialization = (async () => {
        const now = Date.now()
        const rows = (await ctx.collection('sessions').snapshot({ filter: eq('nodeKey', ctx.nodeKey!) })) as AuthSession[]
        const unfinished = rows.filter((row) => row.endedAt === null)
        await Promise.all(unfinished.map((row) => ctx.collection('sessions').update({ ...row, endedAt: now })))
        await Promise.all([...new Set(unfinished.map((row) => row.userId))].map((userId) => refreshPresence(userId)))
      })()
      void initialization.catch(() => {})
      return async () => {
        stopping = true
        await initialization
        await Promise.allSettled(pendingWork)
        const now = Date.now()
        const rows = (await ctx.collection('sessions').snapshot({ filter: eq('nodeId', ctx.nodeId) })) as AuthSession[]
        const unfinished = rows.filter((row) => row.endedAt === null)
        await Promise.all(unfinished.map((row) => ctx.collection('sessions').update({ ...row, endedAt: now })))
        await Promise.all([...new Set(unfinished.map((row) => row.userId))].map((userId) => refreshPresence(userId)))
      }
    },
    onHeartbeat: (_conn, rawCtx, at) => (stopping ? undefined : track(updateSession(rawCtx as AuthContext, at))),
    onDisconnect: (conn, rawCtx) => (stopping ? undefined : track(endSession(rawCtx as AuthContext, conn.lastPongAt))),
    policies: {
      users: usersReadable ? { read: () => undefined } : {}, // open read (public directory); never client-writable
      credentials: {}, // locked: server-only (the co-writer bypasses)
      accessTokens: {}, // locked: server-only
      sessions: {}, // locked: server-only
      userPresence: usersReadable ? { read: () => undefined } : {},
      apiKeys: {}, // locked: server-only
      passwordResets: {}, // locked: server-only
    },
    handlers: (ctx) => {
      const creds = () => ctx.collection('credentials')
      const accessTokens = () => ctx.collection('accessTokens')
      const keys = () => ctx.collection('apiKeys')
      const resets = () => ctx.collection('passwordResets')
      const mint = async (userId: string): Promise<string> => {
        const token = randomToken()
        const now = Date.now()
        await accessTokens().insert({ id: tokenHash(token), userId, createdAt: now, expiresAt: now + accessTokenTtlMs })
        return token
      }
      return {
        signUp: async (input) => {
          const email = input.email.toLowerCase()
          if (await creds().read(email)) throw new SuperLineError('CONFLICT', 'email already registered')
          const userId = newId()
          const passwordHash = await hashPassword(input.password)
          const token = randomToken()
          const now = Date.now()
          await ctx.batch([
            {
              op: 'insert',
              collection: 'users',
              row: { id: userId, displayName: input.displayName, roles: [...defaultRoles], createdAt: now } satisfies AuthUser,
            },
            { op: 'insert', collection: 'credentials', row: { email, userId, passwordHash } satisfies AuthCredential },
            {
              op: 'insert',
              collection: 'accessTokens',
              row: { id: tokenHash(token), userId, createdAt: now, expiresAt: now + accessTokenTtlMs } satisfies AuthAccessToken,
            },
          ])
          return { token, userId, roles: [...defaultRoles], displayName: input.displayName }
        },
        signIn: async (input) => {
          const email = input.email.toLowerCase()
          const cred = (await creds().read(email)) as AuthCredential | undefined
          if (!cred || !(await verifyPassword(input.password, cred.passwordHash)))
            throw new SuperLineError('UNAUTHORIZED', 'invalid email or password')
          const user = await readUser(cred.userId)
          if (!user) throw new SuperLineError('INTERNAL', 'credential without a user')
          if (isDeactivated(user)) throw new SuperLineError('UNAUTHORIZED', 'account is deactivated')
          const token = await mint(user.id)
          // TOCTOU guard: scrypt verification is slow, so a setPassword/deactivate may have landed since we
          // read the credential. Mint FIRST, then re-check freshness: a rotation committing after our insert
          // catches the session in its own flush; one that committed before is caught here — self-delete.
          const [freshCred, freshUser] = await Promise.all([
            creds().read(email) as Promise<AuthCredential | undefined>,
            readUser(cred.userId),
          ])
          if (!freshCred || freshCred.passwordHash !== cred.passwordHash || !freshUser || isDeactivated(freshUser)) {
            await accessTokens().delete(tokenHash(token))
            throw new SuperLineError('UNAUTHORIZED', 'invalid email or password')
          }
          return { token, userId: user.id, roles: user.roles, displayName: user.displayName }
        },
        signOut: async (_input, connCtx) => {
          const auth = connCtx as AuthContext
          if (auth.authMethod === 'access-token' && auth.authId) {
            await accessTokens().delete(auth.authId)
            if (auth.userId) await endSessions(auth.userId, auth.authId, 'access-token')
          } else {
            await endSession(auth)
            if (auth.sessionId) setTimeout(() => requireCtx().toConn(auth.sessionId!).close(), 0)
          }
          return { ok: true }
        },
        whoami: async (_input, connCtx) => {
          const { userId } = connCtx as AuthContext
          if (!userId) return null
          const user = await readUser(userId)
          return user ? { userId: user.id, displayName: user.displayName, roles: user.roles } : null
        },
        createApiKey: async (input, connCtx) => {
          const { userId, roles } = connCtx as AuthContext
          if (!userId) throw new SuperLineError('UNAUTHORIZED', 'sign in to create an API key')
          if (!roles.includes(input.role)) throw new SuperLineError('FORBIDDEN', `you don't hold the role '${input.role}'`)
          const raw = apiKeyToken()
          const now = Date.now()
          const row = {
            id: tokenHash(raw),
            userId,
            role: input.role,
            label: input.label,
            createdAt: now,
            expiresAt: input.expiresInMs ? now + input.expiresInMs : null,
          } satisfies AuthApiKey
          await keys().insert(row)
          // insert-then-recheck (same TOCTOU shape as signIn): a deactivate() racing this connection either
          // committed before now (we see it and self-delete) or after our insert (its key-purge sees the row).
          const owner = await readUser(userId)
          if (!owner || isDeactivated(owner)) {
            await keys().delete(row.id)
            throw new SuperLineError('UNAUTHORIZED', 'account is deactivated')
          }
          const { id, role, label, createdAt, expiresAt } = row
          return { id, role, label, createdAt, expiresAt, key: raw } // raw key returned ONCE
        },
        listApiKeys: async (_input, connCtx) => {
          const { userId } = connCtx as AuthContext
          if (!userId) throw new SuperLineError('UNAUTHORIZED', 'sign in to list API keys')
          const rows = (await keys().snapshot({ filter: eq('userId', userId) })) as AuthApiKey[]
          return rows.map(({ id, role, label, createdAt, expiresAt }) => ({ id, role, label, createdAt, expiresAt }))
        },
        revokeApiKey: async (input, connCtx) => {
          const { userId } = connCtx as AuthContext
          if (!userId) throw new SuperLineError('UNAUTHORIZED', 'sign in to revoke an API key')
          const key = (await keys().read(input.id)) as AuthApiKey | undefined
          if (!key || key.userId !== userId) throw new SuperLineError('NOT_FOUND', 'no such API key')
          await keys().delete(input.id)
          await endSessions(userId, key.id, 'api-key')
          return { ok: true }
        },
        getToken: async (input, connCtx) => {
          if (!assertions) throw new SuperLineError('BAD_REQUEST', 'JWT is not enabled on this server')
          const { userId, roles } = connCtx as AuthContext
          if (!userId) throw new SuperLineError('UNAUTHORIZED', 'sign in to get a token')
          const claims = (input as { claims?: unknown } | undefined)?.claims
          const { token, expiresAt } = await assertions.mintSigned(userId, { roles, claims })
          return { jwt: token, expiresAt }
        },
        requestPasswordReset: async (input) => {
          const email = input.email.toLowerCase()
          const cred = (await creds().read(email)) as AuthCredential | undefined
          if (cred && sendPasswordReset) {
            const user = await readUser(cred.userId)
            if (user && !isDeactivated(user)) {
              const raw = randomToken()
              const now = Date.now()
              await resets().insert({ id: tokenHash(raw), userId: user.id, createdAt: now, expiresAt: now + passwordResetTtlMs })
              await sendPasswordReset({ user, token: raw }) // the host emails the raw token embedded in a link
            }
          }
          return { ok: true } // constant response — never leak whether the email exists
        },
        confirmPasswordReset: async (input) => {
          const reset = (await resets().read(tokenHash(input.token))) as AuthPasswordReset | undefined
          if (!reset || reset.expiresAt < Date.now()) throw new SuperLineError('UNAUTHORIZED', 'invalid or expired reset token')
          // a deactivated account can't be rotated by a pre-ban token (generic error — no state leak)
          const owner = await readUser(reset.userId)
          if (!owner || isDeactivated(owner)) throw new SuperLineError('UNAUTHORIZED', 'invalid or expired reset token')
          const [cred] = (await creds().snapshot({ filter: eq('userId', reset.userId) })) as AuthCredential[]
          if (!cred) throw new SuperLineError('NOT_FOUND', 'no credential for this reset')
          await creds().update({ email: cred.email, userId: cred.userId, passwordHash: await hashPassword(input.newPassword) })
          await resets().delete(reset.id)
          // a password reset logs out every existing session
          const tokens = (await accessTokens().snapshot({ filter: eq('userId', reset.userId) })) as AuthAccessToken[]
          await Promise.all(tokens.map((token) => accessTokens().delete(token.id)))
          await endSessions(reset.userId, undefined, 'access-token')
          return { ok: true }
        },
      }
    },
  }

  // ── imperative management (PLAN-plugin-chat Phase 0) ────────────────────────────────────────────
  // Everything below writes through the plugin co-writer so changes fan out to live subscribers; the
  // co-writer binds at plugin setup, hence the one rule: these need the running server.

  const requireCtx = (): PluginContext => {
    if (!pluginCtx)
      throw new Error(
        'authKit imperative APIs need the running server — pass authKit.plugin to createSuperLineServer({ plugins }) first',
      )
    return pluginCtx
  }
  const col = (n: 'users' | 'credentials' | 'accessTokens' | 'sessions' | 'userPresence' | 'apiKeys' | 'passwordResets') =>
    requireCtx().collection(n)

  const withLock = async <T>(locks: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve()
    const current = previous.then(work, work)
    const tail = current.then(
      () => undefined,
      () => undefined,
    )
    locks.set(key, tail)
    try {
      return await current
    } finally {
      if (locks.get(key) === tail) locks.delete(key)
    }
  }

  const presenceLocks = new Map<string, Promise<void>>()
  const refreshPresence = (userId: string): Promise<void> =>
    withLock(presenceLocks, userId, async () => {
      const rows = (await col('sessions').snapshot({ filter: eq('userId', userId) })) as AuthSession[]
      const live = rows.filter((row) => row.endedAt === null)
      const connectedAt = live.length ? Math.min(...live.map((row) => row.connectedAt)) : null
      const lastSeenAt = rows.length ? Math.max(...rows.map((row) => row.lastSeenAt)) : null
      const existing = await col('userPresence').read(userId)
      const next = { userId, connectedAt, lastSeenAt }
      if (existing) await col('userPresence').update(next)
      else {
        try {
          await col('userPresence').insert(next)
        } catch (error) {
          if ((error as { code?: string }).code !== 'CONFLICT') throw error
          await col('userPresence').update(next)
        }
      }
    })

  const sessionLocks = new Map<string, Promise<void>>()
  const withSessionLock = (sessionId: string, work: () => Promise<void>): Promise<void> =>
    withLock(sessionLocks, sessionId, work)

  const updateSession = async (authCtx: AuthContext, lastSeenAt: number): Promise<void> => {
    if (!authCtx.userId || !authCtx.sessionId) return
    await withSessionLock(authCtx.sessionId, async () => {
      const row = (await col('sessions').read(authCtx.sessionId!)) as AuthSession | undefined
      if (!row || row.endedAt !== null) return
      await col('sessions').update({ ...row, lastSeenAt })
    })
    await refreshPresence(authCtx.userId)
  }

  const endSession = async (authCtx: AuthContext, lastPongAt?: number): Promise<void> => {
    if (!authCtx.userId || !authCtx.sessionId) return
    await withSessionLock(authCtx.sessionId, async () => {
      const row = (await col('sessions').read(authCtx.sessionId!)) as AuthSession | undefined
      if (!row || row.endedAt !== null) return
      await col('sessions').update({
        ...row,
        lastSeenAt: lastPongAt === undefined ? row.lastSeenAt : Math.max(row.lastSeenAt, lastPongAt),
        endedAt: Date.now(),
      })
    })
    await refreshPresence(authCtx.userId)
  }

  const mustRead = async (id: string): Promise<AuthUser> => {
    const user = (await col('users').read(id)) as AuthUser | undefined
    if (!user) throw new SuperLineError('NOT_FOUND', `no user '${id}'`)
    return user
  }
  const assertContractRoles = (roles: string[]): void => {
    for (const r of roles) if (!contractRoles.has(r)) throw new SuperLineError('BAD_REQUEST', `unknown role '${r}'`)
  }
  const deleteWhere = async (n: 'accessTokens' | 'apiKeys' | 'passwordResets', userId: string): Promise<void> => {
    const rows = (await col(n).snapshot({ filter: eq('userId', userId) })) as { id: string }[]
    await Promise.all(rows.map((r) => col(n).delete(r.id)))
  }
  const flushAccessTokens = (userId: string) => deleteWhere('accessTokens', userId)
  const deleteApiKeys = (userId: string) => deleteWhere('apiKeys', userId)
  const deleteResets = (userId: string) => deleteWhere('passwordResets', userId)

  const endSessions = async (userId: string, authId?: string, authMethod?: string): Promise<void> => {
    const rows = (await col('sessions').snapshot({ filter: eq('userId', userId) })) as AuthSession[]
    const now = Date.now()
    const active = rows.filter(
      (row) =>
        row.endedAt === null &&
        (authId === undefined || row.authId === authId) &&
        (authMethod === undefined || row.authMethod === authMethod),
    )
    await Promise.all(
      active.map((row) =>
        withSessionLock(row.id, async () => {
          const current = (await col('sessions').read(row.id)) as AuthSession | undefined
          if (current && current.endedAt === null) await col('sessions').update({ ...current, endedAt: now })
        }),
      ),
    )
    await refreshPresence(userId)
    setTimeout(() => {
      for (const row of active) requireCtx().toConn(row.id).close()
    }, 0)
  }

  // Per-user serialization of the imperative mutators (this kit is the only imperative writer, so a
  // process-local chain suffices): without it, update()'s full-row LWW write-back could race deactivate()
  // and silently erase the deletedAt stamp — un-banning the user.
  const userLocks = new Map<string, Promise<void>>()
  const withUserLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => withLock(userLocks, id, fn)

  const revoke = async (userId: string): Promise<void> => {
    await Promise.all([flushAccessTokens(userId), endSessions(userId)])
    requireCtx().toUser(userId).disconnect()
  }

  // Update a user's client-visible env on all their live connections, cluster-wide (ADR-0012) — for a
  // key rotation / re-scope mid-conversation. The initial value comes from `resolveEnv` at connect.
  const pushEnv = (userId: string, env: AnyEnv<C>): void => {
    requireCtx().toUser(userId).setEnv(env as unknown)
  }

  const users: AuthUsersApi = {
    get: async (id) => (await col('users').read(id)) as AuthUser | undefined,
    find: async (opts = {}) => {
      const filter = andFilters(opts.filter, opts.includeDeactivated ? undefined : activeOnly())
      return (await col('users').snapshot({
        ...(filter ? { filter } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      })) as AuthUser[]
    },
    create: async (input) => {
      requireCtx() // fail fast before any store traffic
      const roles = input.roles ?? [...defaultRoles]
      assertContractRoles(roles)
      const userId = newId()
      const row: AuthUser = {
        id: userId,
        displayName: input.displayName,
        roles,
        createdAt: Date.now(),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }
      await col('users').insert(row)
      return row
    },
    update: (id, patch) =>
      withUserLock(id, async () => {
        const user = await mustRead(id)
        const next: AuthUser = {
          ...user,
          ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        }
        await col('users').update(next)
        return next
      }),
    setRoles: (id, roles) =>
      withUserLock(id, async () => {
        assertContractRoles(roles)
        const user = await mustRead(id)
        await col('users').update({ ...user, roles })
      }),
    deactivate: (id) =>
      withUserLock(id, async () => {
        const user = await mustRead(id)
        await col('users').update({ ...user, deletedAt: Date.now() })
        await Promise.all([flushAccessTokens(id), deleteApiKeys(id), deleteResets(id), endSessions(id)])
        requireCtx().toUser(id).disconnect()
      }),
    reactivate: (id) =>
      withUserLock(id, async () => {
        const user = await mustRead(id)
        // purge anything that slipped past deactivate's point-in-time flushes — leftovers must never revive
        await Promise.all([flushAccessTokens(id), deleteApiKeys(id), deleteResets(id), endSessions(id)])
        await col('users').update({ ...user, deletedAt: null })
      }),
  }

  const credentials: AuthCredentialsApi = {
    create: async (userId, input) => {
      await mustRead(userId)
      const email = input.email.toLowerCase()
      if (await col('credentials').read(email)) throw new SuperLineError('CONFLICT', 'email already registered')
      const row: AuthCredential = { email, userId, passwordHash: input.password ? await hashPassword(input.password) : '' }
      await col('credentials').insert(row)
      return row
    },
    setPassword: (userId, newPassword) =>
      withUserLock(userId, async () => {
        await mustRead(userId)
        const [credential] = (await col('credentials').snapshot({ filter: eq('userId', userId) })) as AuthCredential[]
        if (!credential) throw new SuperLineError('NOT_FOUND', `no credential for user '${userId}'`)
        await col('credentials').update({ ...credential, passwordHash: await hashPassword(newPassword) })
        await Promise.all([
          flushAccessTokens(userId),
          deleteResets(userId),
          endSessions(userId, undefined, 'access-token'),
        ])
      }),
  }

  const apiKeys: AuthApiKeysApi = {
    create: async (userId, opts) => {
      assertContractRoles([opts.role])
      // the wire counterpart enforces .positive() via zod; the imperative path must match — a falsy check
      // would invert expiresInMs: 0 into an IMMORTAL key
      if (opts.expiresInMs !== undefined && !(opts.expiresInMs > 0))
        throw new SuperLineError('BAD_REQUEST', 'expiresInMs must be positive')
      const user = await mustRead(userId)
      if (isDeactivated(user)) throw new SuperLineError('CONFLICT', `user '${userId}' is deactivated`)
      const raw = apiKeyToken()
      const now = Date.now()
      const row = {
        id: tokenHash(raw),
        userId,
        role: opts.role,
        label: opts.label,
        createdAt: now,
        expiresAt: opts.expiresInMs !== undefined ? now + opts.expiresInMs : null,
      } satisfies AuthApiKey
      await col('apiKeys').insert(row)
      const { id, role, label, createdAt, expiresAt } = row
      return { id, role, label, createdAt, expiresAt, key: raw }
    },
    listFor: async (userId) => {
      const rows = (await col('apiKeys').snapshot({ filter: eq('userId', userId) })) as AuthApiKey[]
      return rows.map(({ id, role, label, createdAt, expiresAt }) => ({ id, role, label, createdAt, expiresAt }))
    },
    revoke: async (id) => {
      const key = (await col('apiKeys').read(id)) as AuthApiKey | undefined
      if (!key) throw new SuperLineError('NOT_FOUND', 'no such API key')
      await col('apiKeys').delete(id)
      await endSessions(key.userId, id, 'api-key')
    },
  }

  const requireAssertions = (): NonNullable<typeof assertions> => {
    if (!assertions) throw new SuperLineError('BAD_REQUEST', 'bearer assertions need auth({ jwt: { secret } })')
    return assertions
  }

  const tokens: AuthTokensApi = {
    mintSigned: async (userId, opts = {}) => {
      const kit = requireAssertions()
      const user = await mustRead(userId)
      if (isDeactivated(user)) throw new SuperLineError('CONFLICT', `user '${userId}' is deactivated`)
      return kit.mintSigned(userId, { roles: user.roles, ...opts })
    },
    mintSealed: async (userId, opts = {}) => {
      const kit = requireAssertions()
      const user = await mustRead(userId)
      if (isDeactivated(user)) throw new SuperLineError('CONFLICT', `user '${userId}' is deactivated`)
      return kit.mintSealed(userId, opts)
    },
    verify: async (token) => {
      const verified = await requireAssertions().verify(token)
      if (!verified) return null
      const user = await readUser(verified.userId)
      if (!user || isDeactivated(user)) return null
      // A sealed assertion carries no roles — connect resolves them from the row, so report the same thing.
      return { ...verified, roles: verified.kind === 'sealed' ? user.roles : verified.roles }
    },
  }

  return { authenticate, identify, plugin, revoke, pushEnv, users, credentials, apiKeys, tokens }
}
