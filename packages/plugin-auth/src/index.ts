import { z } from 'zod'
import { defineContractPlugin, defineSurface } from '@super-line/core'

/** The unauthenticated role the auth plugin adds to the contract. The only role name the plugin hardcodes. */
export const GUEST_ROLE = 'guest'
/** A session is publicly online while its last confirmed heartbeat is newer than this threshold. */
export const USER_PRESENCE_LIVE_MS = 90_000

// ── auth collection row schemas ──────────────────────────────────────────────────────────────────

/**
 * The public user directory. World-readable by default; only the server co-writer writes it.
 * `deletedAt` = soft-delete (deactivation): the row stays served so old content keeps rendering its
 * author — absent/null means active. `metadata` is the host's opaque extension slot.
 */
export const userSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  createdAt: z.number(),
  deletedAt: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
/** Secret: email → password hash. `email` is the pk. Server-only (deny-all). */
export const credentialSchema = z.object({
  email: z.string(),
  userId: z.string(),
  passwordHash: z.string(),
})
/** Secret: a reusable password-login bearer token. pk = sha256(token). Server-only (deny-all). */
export const accessTokenSchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
})
/** Secret: one accepted authenticated realtime connection. Server-only (deny-all). */
export const sessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  nodeId: z.string(),
  nodeKey: z.string(),
  role: z.string(),
  transport: z.string(),
  authMethod: z.string(),
  authId: z.string().nullable(),
  connectedAt: z.number(),
  lastSeenAt: z.number(),
  endedAt: z.number().nullable(),
})
/** Safe public aggregate of a user's authenticated connection sessions. */
export const userPresenceSchema = z.object({
  userId: z.string(),
  connectedAt: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
})
/** Secret: a long-lived API key. pk = sha256(key). Server-only (deny-all). Carries ONE fixed role. */
export const apiKeySchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  label: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
})
/** Secret: a pending password-reset. pk = sha256(reset token). Server-only (deny-all). */
export const passwordResetSchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
})

export type AuthUser = z.infer<typeof userSchema>
export type AuthCredential = z.infer<typeof credentialSchema>
export type AuthAccessToken = z.infer<typeof accessTokenSchema>
export type AuthSession = z.infer<typeof sessionSchema>
export type AuthUserPresence = z.infer<typeof userPresenceSchema>
export type AuthApiKey = z.infer<typeof apiKeySchema>
export type AuthPasswordReset = z.infer<typeof passwordResetSchema>

/**
 * The per-connection auth context (`conn.ctx`) the plugin resolves — uniform across roles, `null` fields for a guest.
 *
 * `claims`/`sealed` are present only on a connection that authenticated with a bearer assertion, and carry the
 * payloads it was minted with. **`claims` on a `signed` assertion is client-authored** (any authenticated client can
 * call `getToken({ claims })`), so never authorize on it without checking `authMethod === 'jwt-sealed'` — only a
 * sealed assertion's payloads are server-minted. See ADR-0015.
 */
export interface AuthContext<Claims = Record<string, unknown>, Sealed = Record<string, unknown>> {
  userId: string | null
  roles: string[]
  sessionId: string | null
  /** `'access-token'` · `'api-key'` · `'jwt'` (signed assertion) · `'jwt-sealed'` (sealed assertion). */
  authMethod: string | null
  authId: string | null
  /** The assertion's public payload. Absent on non-assertion connections. */
  claims?: Claims
  /** The assertion's sealed payload — server-minted, never readable by the token's holder. `sealed` assertions only. */
  sealed?: Sealed
}

// ── request defs (shared by the contract fragment AND the server plugin's paired surface) ─────────

const identityOut = z.object({ token: z.string(), userId: z.string(), roles: z.array(z.string()), displayName: z.string() })
const signUpDef = {
  input: z.object({ email: z.string().email(), password: z.string().min(6), displayName: z.string().min(1) }),
  output: identityOut,
}
const signInDef = { input: z.object({ email: z.string().email(), password: z.string() }), output: identityOut }
const signOutDef = { input: z.void(), output: z.object({ ok: z.boolean() }) }
const whoamiDef = {
  input: z.void(),
  output: z.object({ userId: z.string(), displayName: z.string(), roles: z.array(z.string()) }).nullable(),
}
const apiKeyInfo = z.object({
  id: z.string(),
  role: z.string(),
  label: z.string(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
})
const createApiKeyDef = {
  input: z.object({ label: z.string().min(1), role: z.string(), expiresInMs: z.number().positive().optional() }),
  output: apiKeyInfo.extend({ key: z.string() }), // `key` (the raw `slp_…`) is returned ONCE, at creation
}
const listApiKeysDef = { input: z.void(), output: z.array(apiKeyInfo) }
const revokeApiKeyDef = { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) }
// A short-lived SIGNED assertion (JWS) derived from the current session — for stateless verification by other
// backends, or to connect super-line without a DB round-trip. Only issued when the server enables `jwt`.
// `claims` is an optional public payload; it is client-authored, so the server validates it against the host's
// `jwt.claims` schema and surfaces it as `ctx.claims` — never as authority. Sealed assertions are server-only
// (`authKit.tokens.mintSealed`) and deliberately have no client-facing mint. The input is a `void` union so that
// existing `getToken()` callers keep compiling (a `X | undefined` parameter cannot be omitted; `void | X` can).
const getTokenDef = {
  input: z.union([z.void(), z.object({ claims: z.record(z.string(), z.unknown()).optional() })]),
  output: z.object({ jwt: z.string(), expiresAt: z.number() }),
}
// Logged-out password recovery. `requestPasswordReset` always returns { ok: true } (never leaks whether the
// email exists); the server delivers the token via a host `sendPasswordReset` callback.
const requestResetDef = { input: z.object({ email: z.string().email() }), output: z.object({ ok: z.boolean() }) }
const confirmResetDef = {
  input: z.object({ token: z.string(), newPassword: z.string().min(6) }),
  output: z.object({ ok: z.boolean() }),
}

/**
 * The auth plugin's paired surface — the requests its server half answers. Its `clientToServer` keys are
 * subtracted from the host's `implement()` obligation at compile time (see {@link SuperLinePlugin}).
 */
export const authSurface = defineSurface({
  clientToServer: {
    signIn: signInDef,
    signUp: signUpDef,
    signOut: signOutDef,
    whoami: whoamiDef,
    createApiKey: createApiKeyDef,
    listApiKeys: listApiKeysDef,
    revokeApiKey: revokeApiKeyDef,
    getToken: getTokenDef,
    requestPasswordReset: requestResetDef,
    confirmPasswordReset: confirmResetDef,
  },
})
export type AuthSurface = typeof authSurface

/**
 * The contract-time half of the auth plugin. Spread into `defineContract({ plugins: [authContract()] })`: it adds
 * the `users`/`credentials`/`sessions` collections, a `guest` role carrying `signIn`/`signUp`, and `signOut`/`whoami`
 * on `shared` (every role). The host must NOT declare its own `guest` role or `users` collection — auth owns identity,
 * so a collision throws at `defineContract`. Reference the user directory from app rows via `references: { authorId: 'users' }`.
 */
export function authContract() {
  return defineContractPlugin('auth', {
    collections: {
      users: { schema: userSchema, key: 'id' },
      credentials: { schema: credentialSchema, key: 'email' },
      accessTokens: { schema: accessTokenSchema, key: 'id' },
      sessions: { schema: sessionSchema, key: 'id' },
      userPresence: { schema: userPresenceSchema, key: 'userId' },
      apiKeys: { schema: apiKeySchema, key: 'id' },
      passwordResets: { schema: passwordResetSchema, key: 'id' },
    },
    roles: {
      guest: {
        clientToServer: {
          signIn: signInDef,
          signUp: signUpDef,
          requestPasswordReset: requestResetDef,
          confirmPasswordReset: confirmResetDef,
        },
      },
    },
    shared: {
      clientToServer: {
        signOut: signOutDef,
        whoami: whoamiDef,
        createApiKey: createApiKeyDef,
        listApiKeys: listApiKeysDef,
        revokeApiKey: revokeApiKeyDef,
        getToken: getTokenDef,
      },
    },
  })
}
