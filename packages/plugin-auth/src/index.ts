import { z } from 'zod'
import { defineContractPlugin, defineSurface } from '@super-line/core'

/** The unauthenticated role the auth plugin adds to the contract. The only role name the plugin hardcodes. */
export const GUEST_ROLE = 'guest'

// ── auth collection row schemas ──────────────────────────────────────────────────────────────────

/** The public user directory. World-readable by default; only the server co-writer writes it. */
export const userSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  createdAt: z.number(),
})
/** Secret: email → password hash. `email` is the pk. Server-only (deny-all). */
export const credentialSchema = z.object({
  email: z.string(),
  userId: z.string(),
  passwordHash: z.string(),
})
/** Secret: a live session. pk = sha256(token). Server-only (deny-all). Identity only — the role is chosen per connect. */
export const sessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
})

export type AuthUser = z.infer<typeof userSchema>
export type AuthCredential = z.infer<typeof credentialSchema>
export type AuthSession = z.infer<typeof sessionSchema>

/** The per-connection auth context (`conn.ctx`) the plugin resolves — uniform across roles, `null` fields for a guest. */
export interface AuthContext {
  userId: string | null
  roles: string[]
  sessionId: string | null
}

// ── request defs (shared by the contract fragment AND the server plugin's paired surface) ─────────

const identityOut = z.object({ token: z.string(), userId: z.string(), roles: z.array(z.string()) })
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

/**
 * The auth plugin's paired surface — the four requests its server half answers. Its `clientToServer` keys are
 * subtracted from the host's `implement()` obligation at compile time (see {@link SuperLinePlugin}).
 */
export const authSurface = defineSurface({
  clientToServer: { signIn: signInDef, signUp: signUpDef, signOut: signOutDef, whoami: whoamiDef },
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
      sessions: { schema: sessionSchema, key: 'id' },
    },
    roles: { guest: { clientToServer: { signIn: signInDef, signUp: signUpDef } } },
    shared: { clientToServer: { signOut: signOutDef, whoami: whoamiDef } },
  })
}
