import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { SuperLineError } from '@super-line/core'
import type {
  Contract,
  RoleOf,
  Requests,
  Events,
  Topics,
  ClientInput,
  Output,
  EventData,
  EnvOf,
  CollectionName,
  CrdtCollectionName,
  RowOf,
  DocOf,
  CollectionQuery,
} from '@super-line/core'
import type { SuperLineClient, CollectionHandle, DocHandle, CrdtCollectionHandle, LiveRowSet } from '@super-line/client'

/** Identity-stable empty snapshot — a fresh `[]` per read would spin `useSyncExternalStore`. */
const EMPTY: never[] = []

/**
 * Idle-hook write failure. A hook with no live client goes idle for READS (`[]` / `undefined` is a truthful
 * "nothing yet"), but a write must never silently succeed — a swallowed `insert` is indistinguishable from a
 * landed one, so the caller loses data with no signal (ADR-0020).
 */
const noClient = (): SuperLineError =>
  new SuperLineError('UNAUTHORIZED', 'not authenticated — there is no live super-line client')

/** State returned by `useRequest`. */
export interface RequestState<T> {
  /** The last successful result, if any. */
  data?: T
  /** The last error thrown by an auto-fetch, `refetch`, or `call`, if any. */
  error?: unknown
  /** Whether a request (auto or manual) is in flight. */
  loading: boolean
}

/** State returned by {@link useLiveQuery}. */
export interface LiveQueryState<Row> {
  /** Current rows (stable identity between changes; `[]` while idle). */
  rows: Row[]
  /** True once the initial snapshot has been applied. False while idle. */
  ready: boolean
  /** Set if the subscription's `ready` rejected (denial, timeout). */
  error?: unknown
  /** The underlying live set (undefined while idle). A window, not ownership — the hook closes it. */
  sub: LiveRowSet<Row> | undefined
}

/**
 * The context-free glue between a {@link LiveRowSet} and React — the ~20 lines every consumer of the
 * raw client surface used to hand-write. `make` builds the set (return it; the hook owns its lifecycle
 * and closes it on unmount or when `deps` change); pass `null` for the idle state. `make` itself is
 * deliberately NOT a dependency — an inline arrow is safe; re-subscription is driven by `deps` alone.
 */
export function useLiveQuery<Row>(
  make: (() => LiveRowSet<Row>) | null,
  deps: readonly unknown[],
): LiveQueryState<Row> {
  const subRef = useRef<LiveRowSet<Row> | undefined>(undefined)
  const readyRef = useRef(false)
  const errorRef = useRef<unknown>(undefined)
  const pairRef = useRef<LiveQueryState<Row>>({ rows: EMPTY, ready: false, error: undefined, sub: undefined })
  const makeRef = useRef(make)
  makeRef.current = make
  const subscribe = useCallback(
    (onChange: () => void) => {
      subRef.current = undefined
      readyRef.current = false
      errorRef.current = undefined
      const build = makeRef.current
      if (!build) {
        onChange() // fall back to the idle snapshot
        return () => {}
      }
      const sub = build()
      subRef.current = sub
      onChange() // pick up the fresh subscription's rows
      const off = sub.subscribe(() => onChange())
      void sub.ready
        .then(() => {
          if (subRef.current !== sub) return
          readyRef.current = true
          onChange()
        })
        .catch((error: unknown) => {
          if (subRef.current !== sub) return
          errorRef.current = error
          onChange()
        })
      return () => {
        off()
        sub.close()
        if (subRef.current === sub) {
          subRef.current = undefined
          readyRef.current = false
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps drive re-subscription; `make` is read via ref
    [makeRef.current === null, ...deps],
  )
  const getPair = useCallback(() => {
    const rows = (subRef.current?.rows() as Row[] | undefined) ?? (EMPTY as Row[])
    const prev = pairRef.current
    if (prev.rows === rows && prev.ready === readyRef.current && prev.error === errorRef.current && prev.sub === subRef.current)
      return prev
    return (pairRef.current = { rows, ready: readyRef.current, error: errorRef.current, sub: subRef.current })
  }, [])
  return useSyncExternalStore(subscribe, getPair, getPair)
}

/**
 * StrictMode-safe client ownership: builds the client in a COMMITTED effect, closes it in that
 * effect's cleanup, and rebuilds when `deps` change — so StrictMode's dev-mode effect cycle
 * (mount → cleanup → re-run) opens and closes a real socket once extra but never leaks one, and a
 * client constructed during a render React later discards is never created at all. `make` is read via
 * a ref: an inline arrow is safe, `deps` alone drive rebuilds.
 *
 * Returns `null` until the first commit (and between rebuilds) — exactly the state every hook in this
 * package idles on, and what `SuperLineProvider` accepts. Construction connects, so this is the ONLY
 * way to own a client from React that survives StrictMode; a `useState(() => createSuperLineClient(…))`
 * initializer leaks a connected socket every double-invoked render.
 */
export function useSuperLineClient<C extends Contract, R extends RoleOf<C>>(
  make: () => SuperLineClient<C, R>,
  deps: readonly unknown[] = [],
): SuperLineClient<C, R> | null {
  const [client, setClient] = useState<SuperLineClient<C, R> | null>(null)
  const makeRef = useRef(make)
  makeRef.current = make
  useEffect(() => {
    const next = makeRef.current()
    setClient(next)
    return () => {
      next.close()
      setClient((current) => (current === next ? null : current))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` drives rebuilds; `make` rides the ref
  }, deps)
  return client
}

/**
 * Bind typed React hooks to a contract + role. Create the client once, wrap your
 * tree in the returned `<Provider>`, then use the hooks inside.
 *
 * @example
 * ```tsx
 * const { Provider, useRequest, useEvent, useSubscription } = createSuperLineHooks<typeof api, 'user'>()
 *
 * function Root() {
 *   const [client] = useState(() => createSuperLineClient(api, { url, role: 'user' }))
 *   return <Provider client={client}><Room /></Provider>
 * }
 * ```
 */
export function createSuperLineHooks<C extends Contract, R extends RoleOf<C>>() {
  const Context = createContext<SuperLineClient<C, R> | null>(null)

  /**
   * Provides a client to the hooks below. `null` is legal and means "not connected yet" — the hooks go idle
   * rather than throwing, which is what lets an auth-owned binding render a login screen above them.
   */
  function Provider(props: { client: SuperLineClient<C, R> | null; children?: ReactNode }): ReactNode {
    return createElement(Context.Provider, { value: props.client }, props.children)
  }

  /** Access the client from context (throws outside a `<Provider>`, or while it holds no client). */
  function useClient(): SuperLineClient<C, R> {
    const client = useMaybeClient()
    if (!client) throw new Error('useClient must be used within a <Provider> that has a client')
    return client
  }

  /** The client, or `null` — what every hook below reads, so a client-less provider idles instead of throwing. */
  function useMaybeClient(): SuperLineClient<C, R> | null {
    return useContext(Context)
  }

  /** Subscribe to a server-pushed event for the component's lifetime. Idle (never bound) with no client. */
  function useEvent<E extends keyof Events<C, R>>(
    event: E,
    handler: (data: EventData<Events<C, R>[E]>) => void,
  ): void {
    const client = useMaybeClient()
    const ref = useRef(handler)
    useEffect(() => {
      ref.current = handler
    })
    useEffect(() => (client ? client.on(event, (data) => ref.current(data)) : undefined), [client, event])
  }

  /** Subscribe to a topic and return its latest value (or `undefined` before the first message / with no client). */
  function useSubscription<T extends keyof Topics<C, R>>(
    topic: T,
  ): EventData<Topics<C, R>[T]> | undefined {
    const client = useMaybeClient()
    const [data, setData] = useState<EventData<Topics<C, R>[T]>>()
    useEffect(() => {
      // Clear on the way down: a value pushed to the PREVIOUS client's session must not survive into the next.
      if (!client) {
        setData(undefined)
        return
      }
      const sub = client.subscribe(topic, setData)
      return () => sub.unsubscribe()
    }, [client, topic])
    return data
  }

  /**
   * The one request hook, TanStack-style. With an `input` argument it AUTO-FETCHES — on mount, when the
   * input changes (JSON-stable compare), and when the client swaps (new session ⇒ refresh) — unless
   * `enabled: false`. WITHOUT an input argument nothing ever auto-fires: that is the manual/mutation
   * mode, driven entirely through `call(input)`. The arity is the mode switch, so a no-input request
   * opts into auto-fetching by passing an explicit `undefined` input.
   */
  function useRequest<M extends keyof Requests<C, R>>(
    method: M,
    ...rest: [] | [input: ClientInput<Requests<C, R>[M]>, opts?: { enabled?: boolean }]
  ): RequestState<Output<Requests<C, R>[M]>> & {
    /** Run the request with an explicit input (the only path in manual mode). */
    call: (input: ClientInput<Requests<C, R>[M]>) => Promise<Output<Requests<C, R>[M]>>
    /** Re-run with the hook's own input. Rejects in manual mode — there is no input to re-run with. */
    refetch: () => Promise<Output<Requests<C, R>[M]>>
  } {
    const client = useMaybeClient()
    const [state, setState] = useState<RequestState<Output<Requests<C, R>[M]>>>({
      loading: false,
    })
    // Only the newest call owns the shared state: without this, two in-flight calls resolving out of
    // order would leave the *older* response in `data` (the classic search-as-you-type bug). Every
    // caller still gets its own result back from `call` — only the rendered state is last-call-wins.
    const latest = useRef(0)
    const call = useCallback(
      async (input: ClientInput<Requests<C, R>[M]>) => {
        const seq = ++latest.current
        if (!client) {
          const error = noClient()
          if (seq === latest.current) setState({ error, loading: false })
          throw error
        }
        setState({ loading: true })
        try {
          const fn = client[method] as (
            i: ClientInput<Requests<C, R>[M]>,
          ) => Promise<Output<Requests<C, R>[M]>>
          const data = await fn(input)
          if (seq === latest.current) setState({ data, loading: false })
          return data
        } catch (error) {
          if (seq === latest.current) setState({ error, loading: false })
          throw error
        }
      },
      [client, method],
    )
    const hasInput = rest.length > 0
    const enabled = rest[1]?.enabled !== false
    // The input rides a ref so effects key on its JSON, not its per-render identity.
    const inputRef = useRef<{ hasInput: boolean; input: ClientInput<Requests<C, R>[M]> | undefined }>({
      hasInput,
      input: rest[0],
    })
    inputRef.current = { hasInput, input: rest[0] }
    const inputKey = hasInput ? (JSON.stringify(rest[0]) ?? 'undefined') : ''
    const refetch = useCallback(() => {
      const m = inputRef.current
      if (!m.hasInput)
        return Promise.reject(
          new Error('refetch() needs the auto-fetch form (an input argument) — this useRequest is manual; use call(input)'),
        )
      return call(m.input as ClientInput<Requests<C, R>[M]>)
    }, [call])
    // One auto-fire per (client, input) — the ref survives StrictMode's mount→unmount→remount, so the
    // double-invoked effect does not double-send the request.
    const fired = useRef<{ client: unknown; key: string } | null>(null)
    useEffect(() => {
      if (!hasInput || !enabled || !client) return
      if (fired.current && fired.current.client === client && fired.current.key === inputKey) return
      fired.current = { client, key: inputKey }
      // The rejection already landed in `state.error`; swallow the throw so nothing surfaces as unhandled.
      void call(inputRef.current.input as ClientInput<Requests<C, R>[M]>).catch(() => {})
    }, [client, hasInput, enabled, inputKey, call])
    return { ...state, call, refetch }
  }

  /**
   * Open a CRDT document collection (ADR-0007) and track it reactively. The id may be:
   * - a `string` — open that document;
   * - `null`/`undefined` — the idle state (nothing opens; reads are empty, writes throw);
   * - a resolver `() => id | Promise<id>` — for ids that arrive asynchronously (a registry lookup, a
   *   request). It re-runs when `deps` change (like an effect); an inline arrow is safe. Resolving
   *   null/undefined idles; throwing lands on `error`.
   *
   * `ready` is the sequencing signal editors need: it flips true only after the catch-up snapshot has
   * applied, so binding to `native` before `ready` is the bug this field exists to prevent. A denied or
   * absent open surfaces on `error` (it used to be invisible). The handle is closed on unmount.
   */
  function useDoc<N extends CrdtCollectionName<C>>(
    name: N,
    id: string | null | undefined | (() => string | null | undefined | Promise<string | null | undefined>),
    deps?: readonly unknown[],
  ): {
    data: DocOf<C, N> | undefined
    deleted: boolean
    /** True once the catch-up snapshot has applied. False while idle, resolving, or loading. */
    ready: boolean
    /** Open denial / absent doc / resolver failure. Cleared when a new open starts. */
    error: unknown
    /** The reactive {@link DocHandle} (undefined while idle/resolving). A window, not ownership — the hook closes it. */
    handle: DocHandle<DocOf<C, N>> | undefined
    /**
     * The engine's native document handle, or `undefined` before the doc is open. A **value**, not a getter, so
     * it can be a dependency: it keeps its identity across merges and changes only when the underlying document
     * is replaced, which is exactly when anything bound to it (a rich-text editor) must be rebuilt. Narrow it
     * with the engine package's accessor — `yDocOf` for Yjs. Sequence the binding on `ready`, not on presence.
     */
    native: unknown
    set: (value: DocOf<C, N>) => void
    update: (partial: Partial<DocOf<C, N>>) => void
    delete: (path: (string | number)[]) => void
  } {
    type Doc = DocOf<C, N>
    const client = useMaybeClient()
    const isResolver = typeof id === 'function'
    // The resolver rides a ref (an inline arrow must not resubscribe); the string form keys directly.
    const idRef = useRef(id)
    idRef.current = id
    const idKey = isResolver ? ' resolver' : (id ?? ' idle')
    const handleRef = useRef<DocHandle<Doc> | undefined>(undefined)
    const readyRef = useRef(false)
    const errorRef = useRef<unknown>(undefined)
    // `handle.getSnapshot()` is already identity-stable between merges (the CRDT store caches it), but
    // this hook exposes several fields, so the group is memoised too — a fresh object per read would spin
    // useSyncExternalStore forever.
    const pairRef = useRef<{
      data: Doc | undefined
      deleted: boolean
      ready: boolean
      error: unknown
      handle: DocHandle<Doc> | undefined
      native: unknown
    }>({ data: undefined, deleted: false, ready: false, error: undefined, handle: undefined, native: undefined })
    const subscribe = useCallback(
      (onChange: () => void) => {
        handleRef.current = undefined
        readyRef.current = false
        errorRef.current = undefined
        onChange() // fall back to the idle snapshot
        if (!client) return () => {}
        let cancelled = false
        let opened: DocHandle<Doc> | undefined
        let off: (() => void) | undefined
        const open = (docId: string) => {
          const handle = (client.collection(name) as CrdtCollectionHandle<Doc>).open(docId)
          opened = handle
          handleRef.current = handle
          onChange()
          off = handle.subscribe(onChange)
          void handle.ready
            .then(() => {
              if (cancelled || handleRef.current !== handle) return
              readyRef.current = true
              onChange()
            })
            .catch((error: unknown) => {
              if (cancelled || handleRef.current !== handle) return
              errorRef.current = error
              onChange()
            })
        }
        const current = idRef.current
        if (typeof current === 'function') {
          void (async () => {
            try {
              const resolved = await current()
              if (cancelled) return
              if (resolved == null) return // resolver said idle
              open(resolved)
            } catch (error) {
              if (cancelled) return
              errorRef.current = error
              onChange()
            }
          })()
        } else if (current != null) {
          open(current)
        }
        return () => {
          cancelled = true
          off?.()
          opened?.close()
          if (handleRef.current === opened) handleRef.current = undefined
        }
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` drives resolver re-runs; the resolver itself rides idRef
      [client, name, idKey, ...(deps ?? [])],
    )
    const getPair = useCallback(() => {
      const handle = handleRef.current
      const next = {
        data: handle?.getSnapshot(),
        deleted: handle?.deleted ?? false,
        ready: readyRef.current,
        error: errorRef.current,
        handle,
        native: handle?.native(),
      }
      const prev = pairRef.current
      if (
        prev.data === next.data &&
        prev.deleted === next.deleted &&
        prev.ready === next.ready &&
        prev.error === next.error &&
        prev.handle === next.handle &&
        prev.native === next.native
      )
        return prev
      return (pairRef.current = next)
    }, [])
    const { data, deleted, ready, error, handle, native } = useSyncExternalStore(subscribe, getPair, getPair)
    // These return `void`, so an idle write throws synchronously rather than resolving a promise nobody awaits.
    const doc = useCallback((): DocHandle<Doc> => {
      const current = handleRef.current
      if (!current) throw noClient()
      return current
    }, [])
    const set = useCallback((value: Doc) => doc().set(value), [doc])
    const update = useCallback((partial: Partial<Doc>) => doc().update(partial), [doc])
    const del = useCallback((path: (string | number)[]) => doc().delete(path), [doc])
    return { data, deleted, ready, error, handle, native, set, update, delete: del }
  }

  /**
   * Subscribe to a collection subset and track its rows reactively (typed by the contract). Returns the
   * live, ordered + limited `rows`, the `ready`/`error` status of the subscription (so "still loading"
   * and "genuinely empty" are distinguishable, and a denied subscribe is visible), the
   * `insert`/`update`/`delete`/`batch` mutations, and the underlying `handle`/`sub` for anything the
   * wrapped surface doesn't cover. `query: null` is the explicit idle state (no subscription, no live
   * surface) — distinct from `undefined`, which subscribes to the whole collection. For joins and
   * complex live queries, use TanStack DB via `@super-line/tanstack-db` instead — this hook is the thin,
   * single-collection filtered-list surface. Re-subscribes when `name` or `query` changes.
   */
  function useCollection<N extends CollectionName<C>>(
    name: N,
    query?: CollectionQuery | null,
  ): {
    rows: RowOf<C, N>[]
    /** True once the initial snapshot has been applied. False while idle. */
    ready: boolean
    error?: unknown
    insert: (row: RowOf<C, N>) => Promise<void>
    update: (row: RowOf<C, N>) => Promise<void>
    delete: (id: string) => Promise<void>
    /** Apply several ops as ONE atomic batch (all-or-nothing on the server). */
    batch: (ops: Array<{ type: 'insert' | 'update'; row: RowOf<C, N> } | { type: 'delete'; id: string }>) => Promise<void>
    /** The underlying {@link CollectionHandle} (undefined while idle). A window, not ownership. */
    handle: CollectionHandle<RowOf<C, N>> | undefined
    /** The underlying {@link LiveRowSet} (undefined while idle). A window, not ownership — the hook closes it. */
    sub: LiveRowSet<RowOf<C, N>> | undefined
  } {
    const client = useMaybeClient()
    const idle = query === null
    const queryKey = idle ? ' idle' : JSON.stringify(query ?? {}) // stabilize an inline-literal query across renders
    // Stable per (client, name): safe as a consumer dependency, reused by every mutation below.
    const handle = useMemo(
      () => (client && !idle ? (client.collection(name) as CollectionHandle<RowOf<C, N>>) : undefined),
      [client, name, idle],
    )
    const make = useMemo(() => {
      if (!handle) return null
      return () => handle.subscribe(JSON.parse(queryKey) as CollectionQuery)
    }, [handle, queryKey])
    const { rows, ready, error, sub } = useLiveQuery<RowOf<C, N>>(make, [make])
    const insert = useCallback((row: RowOf<C, N>) => handle?.insert(row) ?? Promise.reject(noClient()), [handle])
    const update = useCallback((row: RowOf<C, N>) => handle?.update(row) ?? Promise.reject(noClient()), [handle])
    const del = useCallback((id: string) => handle?.delete(id) ?? Promise.reject(noClient()), [handle])
    const batch = useCallback(
      (ops: Array<{ type: 'insert' | 'update'; row: RowOf<C, N> } | { type: 'delete'; id: string }>) =>
        handle?.batch(ops) ?? Promise.reject(noClient()),
      [handle],
    )
    return { rows, ready, error, insert, update, delete: del, batch, handle, sub }
  }

  /**
   * The connection's server-vended, client-visible {@link SuperLineClient.env} (ADR-0012), tracked
   * reactively: `null` until the first push (or for a role with no `env`), then the latest value, re-rendering
   * on every update. Code-only — wire the creds into effects/calls; never render a raw secret.
   */
  function useEnv(): EnvOf<C, R> | null {
    const client = useMaybeClient()
    // Both callbacks must be identity-stable: React resubscribes whenever `subscribe` changes,
    // so an inline arrow here would tear down and re-add the env listener on every render.
    const subscribe = useCallback(
      (onChange: () => void) => (client ? client.env.subscribe(() => onChange()) : () => {}),
      [client],
    )
    const snapshot = useCallback(() => client?.env.current ?? null, [client])
    return useSyncExternalStore(subscribe, snapshot, snapshot) as EnvOf<C, R> | null
  }

  return { Provider, useClient, useMaybeClient, useEvent, useSubscription, useRequest, useDoc, useCollection, useEnv }
}

// ── the registered, module-level binding (ADR-0026) ──────────────────────────────────────────────
//
// One app, one contract, one binding: declare `Register` once by declaration merging and every export
// below is typed by it — no factory call, no destructuring, no generic threading at call sites. The
// factory above stays the escape hatch for multi-contract apps and tests; note that a factory instance
// is a SEPARATE world (its own context) — mixing its hooks with this registered provider (or vice
// versa) yields silently-empty hooks, so pick one surface per app and use it end to end.

/**
 * Declare your contract and role ONCE, by declaration merging, and the module-level hooks in this
 * package are typed by it:
 *
 * @example
 * ```ts
 * declare module '@super-line/react' {
 *   interface Register {
 *     contract: typeof app
 *     role: 'user'
 *   }
 * }
 * ```
 *
 * `Register` is a PROGRAM-WIDE singleton: exactly one declaration per TypeScript program (a second one
 * is an interface merge conflict). Note for LIBRARY authors: this is a global augmentation — keep the
 * declaration in a source-only ambient file your `.d.ts` build does not emit, or every consumer
 * inherits it and one with its own contract cannot override it.
 */
export interface Register {}

/** The contract from {@link Register}. `never` until you declare one. */
export type RegisteredContract = Register extends { contract: infer C extends Contract } ? C : never
/** The role from {@link Register}. `never` until you declare one. */
export type RegisteredRole = Register extends { role: infer R extends string }
  ? R extends RoleOf<RegisteredContract>
    ? R
    : never
  : never

/**
 * Makes an unregistered app fail at the provider — the one place every app touches — with the property
 * name as the message, instead of leaving a trail of cryptic `never`s at each hook. Exported so plugin
 * providers that FEED the shared context (`SuperLineAuthProvider`) can put the same guard on their own
 * props; inside a plugin's own (unregistered) compilation, cast the guard away at the one render site.
 */
export type RegisterGuard = Register extends { contract: Contract; role: string }
  ? unknown
  : {
      /** ⛔ Declare `interface Register { contract; role }` on '@super-line/react' first. */
      __superLineRegisterMissing: never
    }

// The one binding instance behind every module-level export. Module-level because `Register` is: there
// is exactly one contract per app (ADR-0004), so plugin providers (plugin-auth's session owner, chat's
// auto-builder) can feed THIS context and every hook below sees the same client.
const line = createSuperLineHooks<RegisteredContract, RegisteredRole>()

/**
 * Every re-export below is annotated with an indexed access into this — never left to inference. An
 * inferred type is RESOLVED when the `.d.ts` is emitted, i.e. while `Register` is still empty, which
 * bakes `never` into the published signatures and makes declaration merging silently useless. A written
 * annotation is emitted verbatim, so `RegisteredContract` stays lazy and re-resolves in the consumer's
 * program.
 */
type Hooks = ReturnType<typeof createSuperLineHooks<RegisteredContract, RegisteredRole>>

export type SuperLineProviderProps = RegisterGuard & {
  /** The app's client, or `null` for "not connected yet" — the hooks idle rather than throw on null. */
  client: SuperLineClient<RegisteredContract, RegisteredRole> | null
  children?: ReactNode
}

/**
 * The registered app's provider: feeds the one module-level context every hook below reads. An
 * auth-owned app mounts `<SuperLineAuthProvider>` from `@super-line/plugin-auth/react` instead, which
 * feeds this same context with the live session's client (ADR-0026).
 */
export function SuperLineProvider(props: SuperLineProviderProps): ReactNode {
  const { client, children } = props as {
    client: SuperLineClient<RegisteredContract, RegisteredRole> | null
    children?: ReactNode
  }
  return createElement(line.Provider, { client }, children)
}

/** Access the registered client (throws outside a provider, or while it holds no client). */
export const useClient: Hooks['useClient'] = line.useClient
/** The registered client, or `null` while there is none — the idle-tolerant accessor. */
export const useMaybeClient: Hooks['useMaybeClient'] = line.useMaybeClient
/** Subscribe to a server-pushed event for the component's lifetime. Idle with no client. */
export const useEvent: Hooks['useEvent'] = line.useEvent
/** Subscribe to a topic and track its latest value. Idle with no client. */
export const useSubscription: Hooks['useSubscription'] = line.useSubscription
/** Wrap a request as `{ data, error, isLoading, call }`. `call` rejects `UNAUTHORIZED` with no client. */
export const useRequest: Hooks['useRequest'] = line.useRequest
/** Open a CRDT document by id and track it reactively. Idle reads with no client; writes throw. */
export const useDoc: Hooks['useDoc'] = line.useDoc
/** Subscribe to a collection subset and track its rows. Idle reads with no client; writes reject. */
export const useCollection: Hooks['useCollection'] = line.useCollection
/** The connection's server-vended `env` (ADR-0012). `null` with no client. */
export const useEnv: Hooks['useEnv'] = line.useEnv
