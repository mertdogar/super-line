import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  SuperLineProvider,
  type RegisterGuard,
  type RegisteredContract,
  type RegisteredRole,
} from '@super-line/react'
import { authClient, type AuthClient, type AuthClientOptions, type AuthState } from './client.js'

export type { AuthClient, AuthClientOptions, AuthState, TokenStorage } from './client.js'

/**
 * This module is the auth half of the ONE React binding (ADR-0026): `Register` lives in
 * `@super-line/react` — declare your contract and role THERE, once —
 *
 * ```ts
 * declare module '@super-line/react' {
 *   interface Register {
 *     contract: typeof app
 *     role: 'user'
 *   }
 * }
 * ```
 *
 * — and import the data hooks (`useClient`, `useCollection`, `useDoc`, …) from `@super-line/react`
 * directly. This module exports only what is auth's: {@link SuperLineAuthProvider}, which owns the
 * session lifecycle AND feeds the shared context, and {@link useAuth}.
 */

const AuthCtx = createContext<AuthClient<RegisteredContract, RegisteredRole> | null>(null)

const IDLE: AuthState = { status: 'guest', pending: true, error: null, userId: null, displayName: null, roles: [] }
const noop = (): (() => void) => () => {}

export type SuperLineAuthProviderProps = RegisterGuard & { children?: ReactNode } & (
    | (AuthClientOptions<RegisteredContract, RegisteredRole> & { client?: undefined })
    | { client: AuthClient<RegisteredContract, RegisteredRole> }
  )

// The shared provider is guard-typed for APPS; inside this (unregistered) compilation the guard is
// cast away at the one render site — the session's client flows into @super-line/react's singleton
// context, which is what makes `useCollection` et al. work with no bridge (ADR-0026).
const Feed = SuperLineProvider as unknown as (props: {
  client: AuthClient<RegisteredContract, RegisteredRole>['client'] | null
  children?: ReactNode
}) => ReactNode

/**
 * The app's single super-line provider: owns the auth lifecycle AND feeds the live client to
 * `@super-line/react`'s shared module-level context, so a session replacement (`reauthenticate`,
 * `signIn`, `signOut`) propagates to every hook with no bridge to write.
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
  // Built in a COMMITTED effect, never in a render (StrictMode-safe): a useState-initializer build
  // leaked one connected guest socket per double-invoked render, and closing the kept instance on
  // StrictMode's fake unmount was TERMINAL — the dev app died. Now every build is paired with exactly
  // one close, and the cycle simply constructs a fresh instance. Options are captured at build time
  // (i.e. mount) via a ref, as documented above.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [built, setBuilt] = useState<AuthClient<RegisteredContract, RegisteredRole> | null>(null)
  useEffect(() => {
    if (adopted) {
      setBuilt(null)
      return
    }
    const next = authClient<RegisteredContract, RegisteredRole>(optionsRef.current)
    setBuilt(next)
    return () => {
      next.client.close()
      setBuilt((current) => (current === next ? null : current))
    }
  }, [adopted])
  const auth = adopted ?? built

  const state = useSyncExternalStore(
    auth ? auth.subscribe : noop,
    () => auth?.state ?? IDLE,
    () => auth?.state ?? IDLE,
  )
  // Null until there is a CONFIRMED authed session, so the shared hooks idle rather than running
  // against a guest connection whose every collection subscribe would be denied.
  const client = auth && state.status === 'authed' ? auth.client : null

  return (
    <AuthCtx.Provider value={auth}>
      {/* Children are withheld for the one building commit: useAuth()'s stable-instance contract
          (ADR-0020) holds because no consumer ever renders without an instance to hold. An adopted
          instance exists from the first paint, so nothing is withheld on that path. */}
      <Feed client={client}>{auth ? children : null}</Feed>
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
