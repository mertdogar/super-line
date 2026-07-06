import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Contract, RoleOf } from '@super-line/core'
import { authClient, type AuthClient, type AuthClientOptions, type AuthState } from './client.js'

export interface AuthHookValue<C extends Contract, R extends RoleOf<C>> {
  /** The live super-line client for the current auth state — reactive: it swaps on login/logout. */
  client: AuthClient<C, R>['client']
  /** The current auth state; the hook re-renders when it changes. */
  state: AuthState
  /** `true` once any persisted token has been confirmed or discarded on load (avoids flashing the guest UI). */
  ready: boolean
  signUp: AuthClient<C, R>['signUp']
  signIn: AuthClient<C, R>['signIn']
  signOut: AuthClient<C, R>['signOut']
}

export interface AuthBinding<C extends Contract, R extends RoleOf<C>> {
  AuthProvider: (props: { children: ReactNode }) => ReactNode
  useAuth: () => AuthHookValue<C, R>
  /** The underlying framework-agnostic client, if you need it outside React. */
  auth: AuthClient<C, R>
}

/**
 * Build a React binding around {@link authClient}: an `<AuthProvider>` to mount near your root and a `useAuth()`
 * hook that re-renders on auth-state changes. One auth client instance per `createAuth` call.
 *
 * @example
 * ```tsx
 * const { AuthProvider, useAuth } = createAuth({ authedRole: 'user', connect })
 * // <AuthProvider><App/></AuthProvider>
 * const { state, client, signIn, signOut } = useAuth()
 * ```
 */
export function createAuth<C extends Contract, R extends RoleOf<C>>(options: AuthClientOptions<C, R>): AuthBinding<C, R> {
  const instance = authClient(options)
  const Ctx = createContext(instance)

  function AuthProvider({ children }: { children: ReactNode }): ReactNode {
    return <Ctx.Provider value={instance}>{children}</Ctx.Provider>
  }

  function useAuth(): AuthHookValue<C, R> {
    const client = useContext(Ctx)
    const state = useSyncExternalStore(client.subscribe, () => client.state, () => client.state)
    const [ready, setReady] = useState(false)
    useEffect(() => {
      let alive = true
      void client.ready.then(() => alive && setReady(true))
      return () => void (alive = false)
    }, [client])
    return { client: client.client, state, ready, signUp: client.signUp, signIn: client.signIn, signOut: client.signOut }
  }

  return { AuthProvider, useAuth, auth: instance }
}
