import { SignJWT, jwtVerify } from 'jose'
import { eq, SuperLineError } from '@super-line/core'
import type { Contract, RoleOf, Handshake, CollectionStore } from '@super-line/core'
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
}

const DAY_MS = 86_400_000

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

  const authenticate = async (handshake: Handshake): Promise<AuthResultOf<C>> => {
    const guest = { role: GUEST_ROLE, ctx: { userId: null, roles: [], sessionId: null } } as AuthResultOf<C>
    const requestedRole = handshake.query.role
    if (requestedRole === GUEST_ROLE) return guest

    // API key — a stateful long-lived credential carrying ONE fixed role.
    const apiKey = handshake.query.apiKey
    if (apiKey) {
      const key = await readApiKey(apiKey)
      if (!key || (key.expiresAt !== null && key.expiresAt < Date.now())) return guest
      if (!contractRoles.has(key.role)) throw new SuperLineError('BAD_REQUEST', `api key role '${key.role}' is not a contract role`)
      if (requestedRole && requestedRole !== key.role)
        throw new SuperLineError('FORBIDDEN', `api key grants '${key.role}', not '${requestedRole}'`)
      return { role: key.role, ctx: { userId: key.userId, roles: [key.role], sessionId: null } } as AuthResultOf<C>
    }

    // JWT — stateless: verify signature + expiry and trust its role claims (no session lookup, so unrevocable pre-exp).
    const jwtParam = handshake.query.jwt
    if (jwtSecret && jwtParam) {
      const claims = await verifyJwt(jwtParam)
      if (!claims) return guest
      if (!requestedRole) throw new SuperLineError('BAD_REQUEST', 'a role is required to authenticate')
      if (!contractRoles.has(requestedRole)) throw new SuperLineError('BAD_REQUEST', `unknown role '${requestedRole}'`)
      if (!claims.roles.includes(requestedRole)) throw new SuperLineError('FORBIDDEN', `role '${requestedRole}' not granted`)
      return { role: requestedRole, ctx: { userId: claims.userId, roles: claims.roles, sessionId: null } } as AuthResultOf<C>
    }

    // Session token — no token degrades to guest; an expired/absent session or vanished user does too (client re-logs in).
    const token = handshake.query.token
    if (!token) return guest
    const session = await readSession(token)
    if (!session || session.expiresAt < Date.now()) return guest
    const user = await readUser(session.userId)
    if (!user) return guest
    // valid session: the requested role must be a real contract role AND granted to this user
    if (!requestedRole) throw new SuperLineError('BAD_REQUEST', 'a role is required to authenticate')
    if (!contractRoles.has(requestedRole)) throw new SuperLineError('BAD_REQUEST', `unknown role '${requestedRole}'`)
    if (!user.roles.includes(requestedRole)) throw new SuperLineError('FORBIDDEN', `role '${requestedRole}' not granted`)
    return { role: requestedRole, ctx: { userId: user.id, roles: user.roles, sessionId: session.id } } as AuthResultOf<C>
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
          const token = await mint(user.id)
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
            if (user) {
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

  const revoke = async (userId: string): Promise<void> => {
    if (!pluginCtx) return
    // relay-safe deletes via the co-writer, then a cluster-wide kick of the user's live connections
    const rows = (await pluginCtx.collection('sessions').snapshot({ filter: eq('userId', userId) })) as AuthSession[]
    await Promise.all(rows.map((r) => pluginCtx!.collection('sessions').delete(r.id)))
    pluginCtx.toUser(userId).disconnect()
  }

  return { authenticate, identify, plugin, revoke }
}
