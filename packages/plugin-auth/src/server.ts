import { SuperLineError } from '@super-line/core'
import type { Contract, RoleOf, Handshake, CollectionStore } from '@super-line/core'
import type { SuperLinePlugin } from '@super-line/server'
import { GUEST_ROLE } from './index.js'
import type { AuthContext, AuthCredential, AuthSession, AuthSurface, AuthUser } from './index.js'
import { hashPassword, newId, randomToken, tokenHash, verifyPassword } from './crypto.js'

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
}

export interface AuthServer<C extends Contract> {
  /** Wire at the server's top-level `authenticate:` option. */
  authenticate: (handshake: Handshake) => Promise<AuthResultOf<C>>
  /** Wire at the server's `identify:` option so `principal` becomes the userId (drives collection policies/ACLs). */
  identify: (conn: { ctx: unknown }) => string | undefined
  /** Register in the server's `plugins: [...]` — the signIn/up/out/whoami handlers + open/deny-all row policies. */
  plugin: SuperLinePlugin<AuthSurface>
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

  const readSession = (token: string) => collections.read('sessions', tokenHash(token)) as Promise<AuthSession | undefined>
  const readUser = (id: string) => collections.read('users', id) as Promise<AuthUser | undefined>

  const authenticate = async (handshake: Handshake): Promise<AuthResultOf<C>> => {
    const guest = { role: GUEST_ROLE, ctx: { userId: null, roles: [], sessionId: null } } as AuthResultOf<C>
    const token = handshake.query.token
    const requestedRole = handshake.query.role
    // no token, or an explicit guest connection → guest (unauthenticated)
    if (!token || requestedRole === GUEST_ROLE) return guest
    // an expired/absent session or a vanished user degrades to guest — the client re-logs in, never hangs
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

  const plugin: SuperLinePlugin<AuthSurface> = {
    name: 'auth',
    policies: {
      users: usersReadable ? { read: () => undefined } : {}, // open read (public directory); never client-writable
      credentials: {}, // locked: server-only (the co-writer bypasses)
      sessions: {}, // locked: server-only
    },
    handlers: (ctx) => {
      const users = () => ctx.collection('users')
      const creds = () => ctx.collection('credentials')
      const sessions = () => ctx.collection('sessions')
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
          return { token, userId, roles: [...defaultRoles] }
        },
        signIn: async (input) => {
          const email = input.email.toLowerCase()
          const cred = (await creds().read(email)) as AuthCredential | undefined
          if (!cred || !(await verifyPassword(input.password, cred.passwordHash)))
            throw new SuperLineError('UNAUTHORIZED', 'invalid email or password')
          const user = await readUser(cred.userId)
          if (!user) throw new SuperLineError('INTERNAL', 'credential without a user')
          const token = await mint(user.id)
          return { token, userId: user.id, roles: user.roles }
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
      }
    },
  }

  return { authenticate, identify, plugin }
}
