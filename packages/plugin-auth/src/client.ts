import { GUEST_ROLE } from './index.js'
import type { Contract, RoleOf } from '@super-line/core'
import type { SuperLineClient } from '@super-line/client'

/** The auth lifecycle state the helper exposes. */
export interface AuthState {
  status: 'guest' | 'authed'
  userId: string | null
  displayName: string | null
  roles: string[]
}

/** Where the session token is persisted between page loads. Defaults to `localStorage` when available. */
export interface TokenStorage {
  get(): string | null
  set(token: string | null): void
}

export interface AuthClientOptions<C extends Contract, R extends RoleOf<C>> {
  /** The role to connect as once authenticated (e.g. `'user'`). */
  authedRole: R
  /**
   * (Re)build a super-line client for a role + handshake params. The helper calls this to connect as `guest` ({})
   * and, after login, as `authedRole` ({ token }). The app owns transport/URL here.
   */
  connect: (args: { role: string; params: Record<string, string> }) => SuperLineClient<C, R>
  /** Persist/restore the session token. Defaults to `localStorage` under `superline.auth.token`. */
  storage?: TokenStorage
}

export interface AuthClient<C extends Contract, R extends RoleOf<C>> {
  /** The live super-line client for the current auth state (guest before login, `authedRole` after). */
  readonly client: SuperLineClient<C, R>
  /** The current auth state. */
  readonly state: AuthState
  /** Resolves once any persisted token has been confirmed (or discarded) — await before reading `state` on load. */
  readonly ready: Promise<void>
  /** Subscribe to auth-state changes; returns an unsubscribe. */
  subscribe(cb: (state: AuthState) => void): () => void
  signUp(input: { email: string; password: string; displayName: string }): Promise<void>
  signIn(input: { email: string; password: string }): Promise<void>
  signOut(): Promise<void>
}

interface Identity {
  token: string
  userId: string
  roles: string[]
  displayName: string
}
/** The auth requests as they appear on a live client, regardless of role (they're on the contract via the fragment). */
interface Dyn {
  signIn(i: { email: string; password: string }): Promise<Identity>
  signUp(i: { email: string; password: string; displayName: string }): Promise<Identity>
  signOut(): Promise<{ ok: boolean }>
  whoami(): Promise<{ userId: string; displayName: string; roles: string[] } | null>
  close(): void
}

/**
 * Wrap the guest↔authed lifecycle behind a plain `signIn`/`signUp`/`signOut`. Because super-line freezes a
 * connection's role at connect, "logging in" means tearing down the guest connection and reconnecting with the
 * session token as `authedRole` — this helper does that transparently and persists the token across reloads.
 */
export function authClient<C extends Contract, R extends RoleOf<C>>(options: AuthClientOptions<C, R>): AuthClient<C, R> {
  const storage = options.storage ?? browserStorage()
  const listeners = new Set<(s: AuthState) => void>()
  let current: SuperLineClient<C, R>
  let state: AuthState = { status: 'guest', userId: null, displayName: null, roles: [] }

  const dyn = (c: SuperLineClient<C, R>): Dyn => c as unknown as Dyn
  const setState = (s: AuthState): void => {
    state = s
    for (const l of listeners) l(s)
  }
  const guestClient = (): SuperLineClient<C, R> => options.connect({ role: GUEST_ROLE, params: {} })
  const authedClient = (token: string): SuperLineClient<C, R> => options.connect({ role: options.authedRole, params: { token } })
  const swap = (next: SuperLineClient<C, R>, s: AuthState): void => {
    const prev = current
    current = next
    if (prev && prev !== next) dyn(prev).close()
    setState(s)
  }
  const toGuest = (): void => {
    storage.set(null)
    swap(guestClient(), { status: 'guest', userId: null, displayName: null, roles: [] })
  }
  const login = (id: Identity): void => {
    storage.set(id.token)
    swap(authedClient(id.token), { status: 'authed', userId: id.userId, displayName: id.displayName, roles: id.roles })
  }

  const saved = storage.get()
  current = saved ? authedClient(saved) : guestClient()
  // Restore path: confirm the persisted token with a whoami; drop to guest if it's expired/revoked.
  const ready: Promise<void> = saved
    ? dyn(current)
        .whoami()
        .then((me) => {
          if (me) setState({ status: 'authed', userId: me.userId, displayName: me.displayName, roles: me.roles })
          else toGuest()
        })
        .catch(() => toGuest())
    : Promise.resolve()

  return {
    get client() {
      return current
    },
    get state() {
      return state
    },
    ready,
    subscribe(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    async signUp(input) {
      login(await dyn(current).signUp(input))
    },
    async signIn(input) {
      login(await dyn(current).signIn(input))
    },
    async signOut() {
      try {
        await dyn(current).signOut()
      } catch {
        // best-effort server-side revoke; we drop the local token regardless
      }
      toGuest()
    },
  }
}

function browserStorage(): TokenStorage {
  const KEY = 'superline.auth.token'
  const ls: Storage | undefined =
    typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? (globalThis as { localStorage?: Storage }).localStorage
      : undefined
  return {
    get: () => ls?.getItem(KEY) ?? null,
    set: (t) => {
      if (!ls) return
      if (t) ls.setItem(KEY, t)
      else ls.removeItem(KEY)
    },
  }
}
