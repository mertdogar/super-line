import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createSuperLineHooks } from '@super-line/react'
import type { Contract, RoleOf } from '@super-line/core'
import { authClient, type AuthClient, type AuthClientOptions, type AuthState } from './client.js'

export type { AuthClient, AuthClientOptions, AuthState, TokenStorage } from './client.js'

/**
 * Declare your contract and authed role ONCE, by declaration merging, and every hook in this module is typed
 * by it — no factory, no destructuring, no generic threading at the call site.
 *
 * @example
 * ```ts
 * declare module '@super-line/plugin-auth/react' {
 *   interface Register {
 *     contract: typeof app
 *     role: 'user'
 *   }
 * }
 * ```
 *
 * Note for LIBRARY authors: this is a global augmentation. If you ship a package (rather than an app), keep the
 * declaration in a source-only ambient file your `.d.ts` build does not emit — otherwise every consumer inherits
 * it, and one with its own contract cannot override it.
 */
export interface Register {}

/** The contract from {@link Register}. `never` until you declare one. */
export type RegisteredContract = Register extends { contract: infer C extends Contract } ? C : never
/** The authed role from {@link Register}. `never` until you declare one. */
export type RegisteredRole = Register extends { role: infer R extends string }
  ? R extends RoleOf<RegisteredContract>
    ? R
    : never
  : never

/**
 * Makes an unregistered app fail at the provider — the one place every app touches — with the property name as
 * the message, instead of leaving a trail of cryptic `never`s at each hook.
 */
type RegisterGuard = Register extends { contract: Contract; role: string }
  ? unknown
  : {
      /** ⛔ Declare `interface Register { contract; role }` on '@super-line/plugin-auth/react' first. */
      __superLineRegisterMissing: never
    }

// The one client binding for the app, fed by the provider below. Module-level because `Register` is: there is
// exactly one contract per app (ADR-0004 — one server, one client, one session, one identity).
const line = createSuperLineHooks<RegisteredContract, RegisteredRole>()

/**
 * Every re-export below is annotated with an indexed access into this — never left to inference. An inferred
 * type is RESOLVED when the `.d.ts` is emitted, i.e. while `Register` is still empty, which bakes `never` into
 * the published signatures and makes declaration merging silently useless. A written annotation is emitted
 * verbatim, so `RegisteredContract` stays lazy and re-resolves in the consumer's program.
 */
type Hooks = ReturnType<typeof createSuperLineHooks<RegisteredContract, RegisteredRole>>

const AuthCtx = createContext<AuthClient<RegisteredContract, RegisteredRole> | null>(null)

const IDLE: AuthState = { status: 'guest', pending: true, error: null, userId: null, displayName: null, roles: [] }
const noop = (): (() => void) => () => {}

export type SuperLineAuthProviderProps = RegisterGuard & { children?: ReactNode } & (
    | (AuthClientOptions<RegisteredContract, RegisteredRole> & { client?: undefined })
    | { client: AuthClient<RegisteredContract, RegisteredRole> }
  )

/**
 * The app's single super-line provider: owns the auth lifecycle AND feeds the live client to every hook in this
 * module, so a session replacement (`reauthenticate`, `signIn`, `signOut`) propagates with no bridge to write.
 *
 * Two forms — build one from options, or adopt an instance you already own (`authClient()` from
 * `@super-line/plugin-auth/client`, e.g. when non-React code drives the same session):
 *
 * ```tsx
 * <SuperLineAuthProvider authedRole="user" tokenParam="jwt" resolveToken={mint} connect={connect}>
 * <SuperLineAuthProvider client={auth}>
 * ```
 *
 * **Options are captured at mount.** Changing `resolveToken`/`connect` on a mounted provider does not rebuild
 * the session — an inline arrow would otherwise tear the socket down every render. To change identity, call
 * `useAuth().reauthenticate()`. An instance passed as `client` is yours: the provider never closes it.
 */
export function SuperLineAuthProvider(props: SuperLineAuthProviderProps): ReactNode {
  const { children, client: adopted, ...options } = props as { children?: ReactNode } & {
    client?: AuthClient<RegisteredContract, RegisteredRole>
  } & AuthClientOptions<RegisteredContract, RegisteredRole>
  const [built] = useState(() => (adopted ? null : authClient<RegisteredContract, RegisteredRole>(options)))
  const auth = (adopted ?? built) as AuthClient<RegisteredContract, RegisteredRole>

  // Close only what we built. An adopted instance outlives this tree by definition.
  useEffect(() => (built ? () => built.client.close() : undefined), [built])

  const state = useSyncExternalStore(
    auth.subscribe,
    () => auth.state,
    () => auth.state,
  )
  // Null until there is a CONFIRMED authed session, so the hooks idle rather than running against a guest
  // connection whose every collection subscribe would be denied.
  const client = state.status === 'authed' ? auth.client : null

  return (
    <AuthCtx.Provider value={auth}>
      <line.Provider client={client}>{children}</line.Provider>
    </AuthCtx.Provider>
  )
}

/**
 * The auth client itself — a STABLE reference whose `.state`/`.client` are live getters, re-rendering on every
 * auth-state change. Stable so it is safe as a `useMemo`/`useEffect` dependency; live so reading `.state`
 * inside an async callback sees the truth at that moment, not a snapshot frozen at the render that created it.
 */
export function useAuth(): AuthClient<RegisteredContract, RegisteredRole> {
  const auth = useContext(AuthCtx)
  useSyncExternalStore(
    auth ? auth.subscribe : noop,
    () => auth?.state ?? IDLE,
    () => auth?.state ?? IDLE,
  )
  if (!auth) throw new Error('useAuth must be used within a <SuperLineAuthProvider>')
  return auth
}

/** The live client, or `null` while there is no confirmed session. Every hook below idles on that null. */
export const useClient: Hooks['useMaybeClient'] = line.useMaybeClient
/** Subscribe to a server-pushed event for the component's lifetime. Idle before authentication. */
export const useEvent: Hooks['useEvent'] = line.useEvent
/** Subscribe to a topic and track its latest value. Idle before authentication. */
export const useSubscription: Hooks['useSubscription'] = line.useSubscription
/** Wrap a request as `{ data, error, loading, refetch, call }`. `call` rejects `UNAUTHORIZED` before authentication. */
export const useRequest: Hooks['useRequest'] = line.useRequest
/** Open a CRDT document by id and track it reactively. Idle reads before authentication; writes throw. */
export const useDoc: Hooks['useDoc'] = line.useDoc
/** Subscribe to a collection subset and track its rows. Idle reads before authentication; writes reject. */
export const useCollection: Hooks['useCollection'] = line.useCollection
/** The connection's server-vended `env` (ADR-0012). `null` before authentication. */
export const useEnv: Hooks['useEnv'] = line.useEnv
