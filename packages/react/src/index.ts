import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
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
import type { SuperLineClient, CollectionHandle, DocHandle, CrdtCollectionHandle } from '@super-line/client'

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
  /** The last error thrown by `call`, if any. */
  error?: unknown
  /** Whether a `call` is in flight. */
  isLoading: boolean
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

  /** Wrap a request as `{ data, error, isLoading, call }` for use in components. */
  function useRequest<M extends keyof Requests<C, R>>(
    method: M,
  ): RequestState<Output<Requests<C, R>[M]>> & {
    call: (input: ClientInput<Requests<C, R>[M]>) => Promise<Output<Requests<C, R>[M]>>
  } {
    const client = useMaybeClient()
    const [state, setState] = useState<RequestState<Output<Requests<C, R>[M]>>>({
      isLoading: false,
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
          if (seq === latest.current) setState({ error, isLoading: false })
          throw error
        }
        setState({ isLoading: true })
        try {
          const fn = client[method] as (
            i: ClientInput<Requests<C, R>[M]>,
          ) => Promise<Output<Requests<C, R>[M]>>
          const data = await fn(input)
          if (seq === latest.current) setState({ data, isLoading: false })
          return data
        } catch (error) {
          if (seq === latest.current) setState({ error, isLoading: false })
          throw error
        }
      },
      [client, method],
    )
    return { ...state, call }
  }

  /**
   * Open a CRDT document collection (ADR-0007) by id and track it reactively: returns its latest `data`
   * (`undefined` until the catch-up snapshot arrives, typed from the contract) plus `set`/`update`/`delete`
   * to write through. The document merges concurrent edits; the handle is closed on unmount.
   */
  function useDoc<N extends CrdtCollectionName<C>>(
    name: N,
    id: string,
  ): {
    data: DocOf<C, N> | undefined
    deleted: boolean
    /**
     * The engine's native document handle, or `undefined` before the doc is open. A **value**, not a getter, so
     * it can be a dependency: it keeps its identity across merges and changes only when the underlying document
     * is replaced, which is exactly when anything bound to it (a rich-text editor) must be rebuilt. Narrow it
     * with the engine package's accessor — `yDocOf` for Yjs.
     */
    native: unknown
    set: (value: DocOf<C, N>) => void
    update: (partial: Partial<DocOf<C, N>>) => void
    delete: (path: (string | number)[]) => void
  } {
    type Doc = DocOf<C, N>
    const client = useMaybeClient()
    const handleRef = useRef<DocHandle<Doc> | undefined>(undefined)
    // `handle.getSnapshot()` is already identity-stable between merges (the CRDT store caches it), but
    // this hook exposes several fields, so the group is memoised too — a fresh object per read would spin
    // useSyncExternalStore forever.
    const pairRef = useRef<{ data: Doc | undefined; deleted: boolean; native: unknown }>({
      data: undefined,
      deleted: false,
      native: undefined,
    })
    const subscribe = useCallback(
      (onChange: () => void) => {
        if (!client) {
          handleRef.current = undefined
          onChange() // fall back to the idle snapshot
          return () => {}
        }
        const handle = (client.collection(name) as CrdtCollectionHandle<Doc>).open(id)
        handleRef.current = handle
        onChange()
        const unsub = handle.subscribe(onChange)
        return () => {
          unsub()
          handle.close()
          handleRef.current = undefined
        }
      },
      [client, name, id],
    )
    const getPair = useCallback(() => {
      const handle = handleRef.current
      const next = { data: handle?.getSnapshot(), deleted: handle?.deleted ?? false, native: handle?.native() }
      const prev = pairRef.current
      if (prev.data === next.data && prev.deleted === next.deleted && prev.native === next.native) return prev
      return (pairRef.current = next)
    }, [])
    const { data, deleted, native } = useSyncExternalStore(subscribe, getPair, getPair)
    // These return `void`, so an idle write throws synchronously rather than resolving a promise nobody awaits.
    const doc = useCallback((): DocHandle<Doc> => {
      const handle = handleRef.current
      if (!handle) throw noClient()
      return handle
    }, [])
    const set = useCallback((value: Doc) => doc().set(value), [doc])
    const update = useCallback((partial: Partial<Doc>) => doc().update(partial), [doc])
    const del = useCallback((path: (string | number)[]) => doc().delete(path), [doc])
    return { data, deleted, native, set, update, delete: del }
  }

  /**
   * Subscribe to a collection subset and track its rows reactively (typed by the contract). Returns the live,
   * ordered + limited `rows` plus `insert`/`update`/`delete` mutations. `error` is set if the subscribe is
   * denied. For joins and complex live queries, use TanStack DB via `@super-line/tanstack-db` instead — this
   * hook is the thin, single-collection filtered-list surface. Re-subscribes when `name` or `query` changes.
   */
  function useCollection<N extends CollectionName<C>>(
    name: N,
    query?: CollectionQuery,
  ): {
    rows: RowOf<C, N>[]
    error?: unknown
    insert: (row: RowOf<C, N>) => Promise<void>
    update: (row: RowOf<C, N>) => Promise<void>
    delete: (id: string) => Promise<void>
  } {
    const client = useMaybeClient()
    const queryKey = JSON.stringify(query ?? {}) // stabilize an inline-literal query across renders
    const [error, setError] = useState<unknown>()
    const handleRef = useRef<CollectionHandle<RowOf<C, N>> | undefined>(undefined)
    const subRef = useRef<ReturnType<CollectionHandle<RowOf<C, N>>['subscribe']> | undefined>(undefined)
    // `sub.rows()` returns the client's `view` array, which keeps a stable identity between changes —
    // exactly the getSnapshot contract, so the rows are read straight from the store instead of being
    // mirrored into component state. React calls `subscribe` in a passive effect, so opening the
    // subscription here has the same timing as the effect it replaces.
    const subscribe = useCallback(
      (onChange: () => void) => {
        if (!client) {
          handleRef.current = undefined
          subRef.current = undefined
          setError(undefined)
          onChange() // fall back to the idle empty rows
          return () => {}
        }
        const handle = client.collection(name) as CollectionHandle<RowOf<C, N>> // useCollection is the LWW row surface
        handleRef.current = handle
        setError(undefined)
        const sub = handle.subscribe(JSON.parse(queryKey) as CollectionQuery)
        subRef.current = sub
        onChange() // pick up the fresh subscription's rows on name/query change
        const off = sub.subscribe(onChange)
        void sub.ready.then(onChange).catch(setError)
        return () => {
          off()
          sub.close()
          subRef.current = undefined
          handleRef.current = undefined
        }
      },
      [client, name, queryKey],
    )
    const getRows = useCallback(() => (subRef.current?.rows() as RowOf<C, N>[] | undefined) ?? EMPTY, [])
    const rows = useSyncExternalStore(subscribe, getRows, () => EMPTY as RowOf<C, N>[])
    const insert = useCallback((row: RowOf<C, N>) => handleRef.current?.insert(row) ?? Promise.reject(noClient()), [])
    const update = useCallback((row: RowOf<C, N>) => handleRef.current?.update(row) ?? Promise.reject(noClient()), [])
    const del = useCallback((id: string) => handleRef.current?.delete(id) ?? Promise.reject(noClient()), [])
    return { rows, error, insert, update, delete: del }
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
