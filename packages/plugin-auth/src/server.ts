import { SignJWT, jwtVerify } from 'jose'
import { andFilters, eq, gt, not, SuperLineError } from '@super-line/core'
import type { Contract, RoleOf, Handshake, CollectionStore, Expr, AnyEnv } from '@super-line/core'
import type { PluginContext, SuperLinePlugin } from '@super-line/server'
import { GUEST_ROLE } from './index.js'
import type { AuthApiKey, AuthContext, AuthCredential, AuthPasswordReset, AuthSession, AuthSurface, AuthUser } from './index.js'
import { apiKeyToken, hashPassword, newId, randomToken, tokenHash, verifyPassword } from './crypto.js'

/**
 * The discriminated auth result — a member per contract role, all sharing the uniform {@link AuthContext}. Assignable
 * to the server's `AuthResult<C>` (whose per-role ctx is `unknown`), so `authenticate:` infers `A` on the proven path.
 */
type AuthResultOf<C extends Contract> = { [R in RoleOf<C>]: { role: R; ctx: AuthContext } }[RoleOf<C>]

export interface AuthServerOptions<C extends Contract> {
  /** The app contract — types the resolved role and validates a requested role against the contract's roles. */
  contract: C
  /** The SAME `CollectionStore` passed to `createSuperLineServer({ collections })`; `authenticate` reads it directly. */
  collections: CollectionStore
  /** Roles granted to a newly signed-up user (must be contract roles). Default `['user']`. */
  defaultRoles?: string[]
  /** Session lifetime in ms. Default 30 days. */
  sessionTtlMs?: number
  /** Whether the `users` directory is client-readable (open read policy). Default `true`. */
  usersReadable?: boolean
  /** Enable JWT: `getToken` issuance + stateless JWT connect (HS256). Omit to disable both. `ttlMs` default 15 min. */
  jwt?: { secret: string; ttlMs?: number }
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
   * Provision a user (email lowercased; roles default to the kit's `defaultRoles`, validated against the
   * contract). Omit `password` for the invite flow: the account exists but can't sign in until claimed via
   * the password-reset flow.
   */
  create(input: {
    email: string
    password?: string
    displayName: string
    roles?: string[]
    metadata?: Record<string, unknown>
  }): Promise<AuthUser>
  /** Patch profile fields (displayName / metadata) and return the updated row. */
  update(id: string, patch: { displayName?: string; metadata?: Record<string, unknown> }): Promise<AuthUser>
  /** Replace the user's roles (validated against contract roles). Connect-time — live connections keep their role. */
  setRoles(id: string, roles: string[]): Promise<void>
  /** Soft-delete: stamp `deletedAt`, flush sessions + API keys + pending reset tokens, kick live connections cluster-wide. */
  deactivate(id: string): Promise<void>
  /** Lift a deactivation (`deletedAt` → null), re-purging sessions/keys/resets first so nothing stale revives. */
  reactivate(id: string): Promise<void>
  /** Admin password rotation: replaces the credential hash, flushes every session AND pending reset token. */
  setPassword(id: string, newPassword: string): Promise<void>
}

/** Imperative API-key management — the server-side counterpart of the client requests; provisions agents. */
export interface AuthApiKeysApi {
  /** Mint a key for a user (role validated against the contract). The raw `slp_…` is returned ONCE. */
  create(userId: string, opts: { role: string; label: string; expiresInMs?: number }): Promise<ApiKeyInfo & { key: string }>
  listFor(userId: string): Promise<ApiKeyInfo[]>
  revoke(id: string): Promise<void>
}

export interface AuthServer<C extends Contract> {
  /** Wire at the server's top-level `authenticate:` option. */
  authenticate: (handshake: Handshake) => Promise<AuthResultOf<C>>
  /** Wire at the server's `identify:` option so `principal` becomes the userId (drives collection policies/ACLs). */
  identify: (conn: { ctx: unknown }) => string | undefined
  /** Register in the server's `plugins: [...]` — the signIn/up/out/whoami handlers + open/deny-all row policies. */
  plugin: SuperLinePlugin<AuthSurface>
  /**
   * Log a user out everywhere: delete all their sessions (relay-safe) AND disconnect their live connections
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
 *   collections: backend,
 *   authenticate: authKit.authenticate,
 *   identify: authKit.identify,
 *   plugins: [authKit.plugin],
 * })
 * ```
 */
export function auth<C extends Contract>(opts: AuthServerOptions<C>): AuthServer<C> {
  const { contract, collections, defaultRoles = ['user'], sessionTtlMs = 30 * DAY_MS, usersReadable = true } = opts
  const contractRoles = new Set(Object.keys(contract.roles))
  const jwtSecret = opts.jwt ? new TextEncoder().encode(opts.jwt.secret) : undefined
  const jwtTtlMs = opts.jwt?.ttlMs ?? 15 * 60_000
  const sendPasswordReset = opts.sendPasswordReset
  const passwordResetTtlMs = opts.passwordResetTtlMs ?? 60 * 60_000

  const readSession = (token: string) => collections.read('sessions', tokenHash(token)) as Promise<AuthSession | undefined>
  const readUser = (id: string) => collections.read('users', id) as Promise<AuthUser | undefined>
  const readApiKey = (raw: string) => collections.read('apiKeys', tokenHash(raw)) as Promise<AuthApiKey | undefined>
  const verifyJwt = async (raw: string): Promise<{ userId: string; roles: string[] } | null> => {
    if (!jwtSecret) return null
    try {
      const { payload } = await jwtVerify(raw, jwtSecret)
      return payload.sub ? { userId: payload.sub, roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [] } : null
    } catch {
      return null // bad/expired signature → treated as unauthenticated
    }
  }

  const resolveBase = async (handshake: Handshake): Promise<AuthResultOf<C>> => {
    const guest = { role: GUEST_ROLE, ctx: { userId: null, roles: [], sessionId: null } } as AuthResultOf<C>
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
      return { role: key.role, ctx: { userId: key.userId, roles: [key.role], sessionId: null } } as AuthResultOf<C>
    }

    // JWT — verify signature + expiry and trust its role claims. One user read (the deactivation check —
    // PLAN-plugin-chat decision 10) is the deliberate dent in statelessness; roles still come from the claims.
    const jwtParam = handshake.query.jwt
    if (jwtSecret && jwtParam) {
      const claims = await verifyJwt(jwtParam)
      if (!claims) return guest
      const subject = await readUser(claims.userId)
      if (!subject || isDeactivated(subject)) return guest
      if (!requestedRole) throw new SuperLineError('BAD_REQUEST', 'a role is required to authenticate')
      if (!contractRoles.has(requestedRole)) throw new SuperLineError('BAD_REQUEST', `unknown role '${requestedRole}'`)
      if (!claims.roles.includes(requestedRole)) throw new SuperLineError('FORBIDDEN', `role '${requestedRole}' not granted`)
      return { role: requestedRole, ctx: { userId: claims.userId, roles: claims.roles, sessionId: null } } as AuthResultOf<C>
    }

    // Session token — no token degrades to guest; an expired/absent session, vanished user, or deactivated
    // user does too (client re-logs in).
    const token = handshake.query.token
    if (!token) return guest
    const session = await readSession(token)
    if (!session || session.expiresAt < Date.now()) return guest
    const user = await readUser(session.userId)
    if (!user || isDeactivated(user)) return guest
    // valid session: the requested role must be a real contract role AND granted to this user
    if (!requestedRole) throw new SuperLineError('BAD_REQUEST', 'a role is required to authenticate')
    if (!contractRoles.has(requestedRole)) throw new SuperLineError('BAD_REQUEST', `unknown role '${requestedRole}'`)
    if (!user.roles.includes(requestedRole)) throw new SuperLineError('FORBIDDEN', `role '${requestedRole}' not granted`)
    return { role: requestedRole, ctx: { userId: user.id, roles: user.roles, sessionId: session.id } } as AuthResultOf<C>
  }

  // Resolve identity (above), then seed the client-visible env (ADR-0012) from it via the host's resolveEnv.
  // ctx and env are produced by ONE connect-time call but stay separate: ctx server-only+frozen, env client-visible.
  const authenticate = async (handshake: Handshake): Promise<AuthResultOf<C>> => {
    const base = await resolveBase(handshake)
    if (!opts.resolveEnv) return base
    const env = await opts.resolveEnv(base.ctx as AuthContext)
    return (env == null ? base : { ...base, env }) as AuthResultOf<C>
  }

  const identify = (conn: { ctx: unknown }): string | undefined => (conn.ctx as AuthContext).userId ?? undefined

  // captured at startup so `revoke` (callable outside a handler) can reach the co-writer + cluster-wide kick
  let pluginCtx: PluginContext | undefined
  const plugin: SuperLinePlugin<AuthSurface> = {
    name: 'auth',
    setup: (ctx) => void (pluginCtx = ctx),
    policies: {
      users: usersReadable ? { read: () => undefined } : {}, // open read (public directory); never client-writable
      credentials: {}, // locked: server-only (the co-writer bypasses)
      sessions: {}, // locked: server-only
      apiKeys: {}, // locked: server-only
      passwordResets: {}, // locked: server-only
    },
    handlers: (ctx) => {
      const users = () => ctx.collection('users')
      const creds = () => ctx.collection('credentials')
      const sessions = () => ctx.collection('sessions')
      const keys = () => ctx.collection('apiKeys')
      const resets = () => ctx.collection('passwordResets')
      const mint = async (userId: string): Promise<string> => {
        const token = randomToken()
        const now = Date.now()
        await sessions().insert({ id: tokenHash(token), userId, createdAt: now, expiresAt: now + sessionTtlMs })
        return token
      }
      return {
        signUp: async (input) => {
          const email = input.email.toLowerCase()
          if (await creds().read(email)) throw new SuperLineError('CONFLICT', 'email already registered')
          const userId = newId()
          const passwordHash = await hashPassword(input.password)
          // ordered so the fail-fast (dup email) hits first; residual failures leave at worst an unreferenced user row
          await creds().insert({ email, userId, passwordHash } satisfies AuthCredential)
          await users().insert({ id: userId, displayName: input.displayName, roles: [...defaultRoles], createdAt: Date.now() } satisfies AuthUser)
          const token = await mint(userId)
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
            await sessions().delete(tokenHash(token))
            throw new SuperLineError('UNAUTHORIZED', 'invalid email or password')
          }
          return { token, userId: user.id, roles: user.roles, displayName: user.displayName }
        },
        signOut: async (_input, connCtx) => {
          const { sessionId } = connCtx as AuthContext
          if (sessionId) await sessions().delete(sessionId)
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
          return { ok: true }
        },
        getToken: async (_input, connCtx) => {
          if (!jwtSecret) throw new SuperLineError('BAD_REQUEST', 'JWT is not enabled on this server')
          const { userId, roles, sessionId } = connCtx as AuthContext
          if (!userId) throw new SuperLineError('UNAUTHORIZED', 'sign in to get a token')
          const now = Date.now()
          const expiresAt = now + jwtTtlMs
          const token = await new SignJWT({ roles, sid: sessionId })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(userId)
            .setIssuedAt(Math.floor(now / 1000))
            .setExpirationTime(Math.floor(expiresAt / 1000))
            .sign(jwtSecret)
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
          const sess = (await sessions().snapshot({ filter: eq('userId', reset.userId) })) as AuthSession[]
          await Promise.all(sess.map((s) => sessions().delete(s.id)))
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
  const col = (n: 'users' | 'credentials' | 'sessions' | 'apiKeys' | 'passwordResets') => requireCtx().collection(n)

  const mustRead = async (id: string): Promise<AuthUser> => {
    const user = (await col('users').read(id)) as AuthUser | undefined
    if (!user) throw new SuperLineError('NOT_FOUND', `no user '${id}'`)
    return user
  }
  const assertContractRoles = (roles: string[]): void => {
    for (const r of roles) if (!contractRoles.has(r)) throw new SuperLineError('BAD_REQUEST', `unknown role '${r}'`)
  }
  const deleteWhere = async (n: 'sessions' | 'apiKeys' | 'passwordResets', userId: string): Promise<void> => {
    const rows = (await col(n).snapshot({ filter: eq('userId', userId) })) as { id: string }[]
    await Promise.all(rows.map((r) => col(n).delete(r.id)))
  }
  const flushSessions = (userId: string) => deleteWhere('sessions', userId)
  const deleteApiKeys = (userId: string) => deleteWhere('apiKeys', userId)
  const deleteResets = (userId: string) => deleteWhere('passwordResets', userId)

  // Per-user serialization of the imperative mutators (this kit is the only imperative writer, so a
  // process-local chain suffices): without it, update()'s full-row LWW write-back could race deactivate()
  // and silently erase the deletedAt stamp — un-banning the user.
  const userLocks = new Map<string, Promise<void>>()
  const withUserLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = userLocks.get(id) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    userLocks.set(id, tail)
    void tail.then(() => {
      if (userLocks.get(id) === tail) userLocks.delete(id)
    })
    return run
  }

  const revoke = async (userId: string): Promise<void> => {
    // relay-safe session deletes via the co-writer, then a cluster-wide kick of the live connections
    await flushSessions(userId)
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
      const email = input.email.toLowerCase()
      const roles = input.roles ?? [...defaultRoles]
      assertContractRoles(roles)
      if (await col('credentials').read(email)) throw new SuperLineError('CONFLICT', 'email already registered')
      const userId = newId()
      // no password → unclaimed (invite flow): an empty hash verifies false for EVERY password, so the
      // account can't sign in until claimed through the password-reset flow
      const passwordHash = input.password ? await hashPassword(input.password) : ''
      await col('credentials').insert({ email, userId, passwordHash } satisfies AuthCredential)
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
        await Promise.all([flushSessions(id), deleteApiKeys(id), deleteResets(id)])
        requireCtx().toUser(id).disconnect()
      }),
    reactivate: (id) =>
      withUserLock(id, async () => {
        const user = await mustRead(id)
        // purge anything that slipped past deactivate's point-in-time flushes — leftovers must never revive
        await Promise.all([flushSessions(id), deleteApiKeys(id), deleteResets(id)])
        await col('users').update({ ...user, deletedAt: null })
      }),
    setPassword: (id, newPassword) =>
      withUserLock(id, async () => {
        await mustRead(id)
        const [cred] = (await col('credentials').snapshot({ filter: eq('userId', id) })) as AuthCredential[]
        if (!cred) throw new SuperLineError('NOT_FOUND', `no credential for user '${id}'`)
        await col('credentials').update({ ...cred, passwordHash: await hashPassword(newPassword) })
        // a rotation revokes every outstanding way back in: live sessions AND pending reset tokens
        await Promise.all([flushSessions(id), deleteResets(id)])
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
    },
  }

  return { authenticate, identify, plugin, revoke, pushEnv, users, apiKeys }
}
