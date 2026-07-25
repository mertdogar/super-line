import { GUEST_ROLE } from './index.js'
import { SuperLineError, type Contract, type RoleOf } from '@super-line/core'
import type { SuperLineClient } from '@super-line/client'

/** The auth lifecycle state the helper exposes. */
export interface AuthState {
  /** Whether there is a confirmed authenticated session right now. Describes the CURRENT session, not a pending one. */
  status: 'guest' | 'authed'
  /**
   * A session replacement is in flight (boot, sign-in/out, or `reauthenticate`). `status`/`userId` keep
   * describing the still-live incumbent throughout, so a UI shows a spinner instead of tearing its tree down.
   */
  pending: boolean
  /**
   * Set when a PRESENTED token was rejected — a bad credential from the source, or a refused connect under the
   * server's `rejectUnauthenticated` — or when the source itself threw. `null` otherwise. Lets the UI render a
   * reconnect banner instead of silently `NOT_FOUND`ing every call. (A source that answers `null` is a
   * deliberate "no credential", not a failure: it drops to guest with no error.)
   */
  error: { reason: string } | null
  userId: string | null
  displayName: string | null
  roles: string[]
}

/** Where the access token is persisted between page loads. Defaults to `localStorage` when available. */
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
  /** Persist/restore the access token. Defaults to `localStorage` under `superline.auth.token`. */
  storage?: TokenStorage
  /**
   * The handshake param key the token rides under. Default `'token'` (the password access-token slot). Set
   * `'jwt'` to connect with a server-minted signed/sealed assertion (→ `authMethod: 'jwt'` / `'jwt-sealed'`).
   */
  tokenParam?: string
  /**
   * The **credential source**: the app's standing answer to "what credential should this client connect with?"
   * — for tokens minted out-of-band (e.g. a server-sealed assertion fetched over HTTP). When set it REPLACES
   * the persisted-`storage` restore.
   *
   * It is not a boot hook: boot is merely its FIRST consultation and every {@link AuthClient.reauthenticate} is
   * another, which is what makes account switching, post-expiry re-acquisition and retry-after-rejection one
   * operation (ADR-0020). The helper starts as `guest`, awaits the first call before resolving `ready`, and
   * swaps to `authedRole` if it yields a token — so a consumer just `await auth.ready` instead of hand-rolling
   * a "client not ready yet" deferred. Return `null` to stay unauthenticated (no error). Its result is NOT
   * persisted to `storage` — the source owns re-acquisition.
   */
  resolveToken?: () => Promise<{ token: string } | null>
}

export interface AuthClient<C extends Contract, R extends RoleOf<C>> {
  /** The live super-line client for the current auth state (guest before login, `authedRole` after). */
  readonly client: SuperLineClient<C, R>
  /** The current auth state. */
  readonly state: AuthState
  /**
   * Resolves once the BOOT consultation of the credential source has been confirmed or discarded. Await before
   * reading `state` on load. Boot-only and one-shot — a later replacement is observed through `state.pending`
   * and through {@link reauthenticate}'s resolved state, so this promise's identity never changes.
   */
  readonly ready: Promise<void>
  /** Subscribe to auth-state changes; returns an unsubscribe. */
  subscribe(cb: (state: AuthState) => void): () => void
  signUp(input: { email: string; password: string; displayName: string }): Promise<void>
  signIn(input: { email: string; password: string }): Promise<void>
  signOut(): Promise<void>
  /**
   * Re-consult the credential source and replace the session with whatever it now yields — the generic
   * identity-change trigger (ADR-0020). Use it to switch accounts, to re-acquire after an expiry, to retry a
   * rejected boot, or (with no `resolveToken`) to revalidate the persisted token.
   *
   * **Never destroys a session it could not replace**: the candidate connection is built and confirmed before
   * the incumbent is closed, so a source that throws — or a credential the server refuses — leaves the live
   * session running and sets `state.error`. Only a `null` from the source drops to guest (a local drop, no
   * server-side revoke — that's `signOut`).
   *
   * Resolves with the SETTLED state rather than throwing on a rejected credential; it throws only on misuse —
   * calling it while another transition is in flight (`state.pending`).
   */
  reauthenticate(): Promise<AuthState>
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
 * Wrap the guest↔authed lifecycle behind a plain `signIn`/`signUp`/`signOut`/`reauthenticate`. Because
 * super-line freezes a connection's role AND its credential at connect, every identity change is a **session
 * replacement** (ADR-0020): tear one connection down, open another. This helper is the machine that owns it.
 */
export function authClient<C extends Contract, R extends RoleOf<C>>(options: AuthClientOptions<C, R>): AuthClient<C, R> {
  const storage = options.storage ?? browserStorage()
  const listeners = new Set<(s: AuthState) => void>()
  // Lazy: a boot that confirms a stored token swaps its candidate straight in, so the common cold-load never
  // opens a throwaway guest socket at all. Reading `.client` (or calling `signIn`) materialises one on demand.
  let current: SuperLineClient<C, R> | undefined
  let state: AuthState = { status: 'guest', pending: false, error: null, userId: null, displayName: null, roles: [] }

  const dyn = (c: SuperLineClient<C, R>): Dyn => c as unknown as Dyn
  const setState = (s: AuthState): void => {
    state = s
    for (const l of listeners) l(s)
  }
  const guestClient = (): SuperLineClient<C, R> => options.connect({ role: GUEST_ROLE, params: {} })
  const authedClient = (token: string): SuperLineClient<C, R> =>
    options.connect({ role: options.authedRole, params: { [options.tokenParam ?? 'token']: token } })
  const live = (): SuperLineClient<C, R> => (current ??= guestClient())
  const swap = (next: SuperLineClient<C, R>, s: AuthState): void => {
    const prev = current
    current = next
    if (prev && prev !== next) dyn(prev).close()
    setState(s)
  }
  const toGuest = (): void => {
    storage.set(null)
    swap(guestClient(), { status: 'guest', pending: false, error: null, userId: null, displayName: null, roles: [] })
  }
  const login = (id: Identity): void => {
    storage.set(id.token)
    swap(authedClient(id.token), {
      status: 'authed',
      pending: false,
      error: null,
      userId: id.userId,
      displayName: id.displayName,
      roles: id.roles,
    })
  }

  const reasonOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : 'the token was rejected')

  // The credential source. `resolveToken` when set, else the persisted access token — boot and every
  // `reauthenticate` consult the same one, which is why they share a single code path.
  const source =
    options.resolveToken ??
    (async (): Promise<{ token: string } | null> => {
      const token = storage.get()
      return token ? { token } : null
    })

  /** Claim the machine for one transition. Only one runs at a time — a second is misuse, not a queue. */
  const begin = (): void => {
    if (state.pending) throw new SuperLineError('CONFLICT', 'an auth transition is already in flight')
    setState({ ...state, pending: true })
  }
  const settle = (patch: Partial<AuthState>): AuthState => {
    setState({ ...state, pending: false, ...patch })
    return state
  }

  /**
   * One session replacement. The candidate is built and `whoami`-confirmed BEFORE the incumbent is closed, so
   * a source that can't answer leaves the live session untouched — there is no window where `client` is dead.
   */
  const transition = async (): Promise<AuthState> => {
    let acquired: { token: string } | null
    try {
      acquired = await source()
    } catch (err) {
      return settle({ error: { reason: reasonOf(err) } })
    }
    // A deliberate "no credential" — a LOCAL drop, no server-side revoke (that's `signOut`).
    if (!acquired) {
      if (state.status !== 'authed') return settle({ error: null })
      storage.set(null)
      swap(guestClient(), { status: 'guest', pending: false, error: null, userId: null, displayName: null, roles: [] })
      return state
    }
    const candidate = authedClient(acquired.token)
    let me: { userId: string; displayName: string; roles: string[] } | null
    try {
      me = await dyn(candidate).whoami()
    } catch (err) {
      dyn(candidate).close()
      return settle({ error: { reason: reasonOf(err) } })
    }
    if (!me) {
      dyn(candidate).close()
      return settle({ error: { reason: 'the token was rejected' } })
    }
    swap(candidate, {
      status: 'authed',
      pending: false,
      error: null,
      userId: me.userId,
      displayName: me.displayName,
      roles: me.roles,
    })
    return state
  }

  begin()
  const ready = transition().then(() => undefined)

  return {
    get client() {
      return live()
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
      begin()
      try {
        login(await dyn(live()).signUp(input))
      } catch (err) {
        settle({}) // a refused credential is the REQUEST's failure, surfaced by the throw — not `state.error`
        throw err
      }
    },
    async signIn(input) {
      begin()
      try {
        login(await dyn(live()).signIn(input))
      } catch (err) {
        settle({})
        throw err
      }
    },
    async signOut() {
      begin()
      try {
        await dyn(live()).signOut()
      } catch {
        // best-effort server-side revoke; we drop the local token regardless
      }
      toGuest()
    },
    async reauthenticate() {
      begin()
      return transition()
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
