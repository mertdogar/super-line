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

  /** Provides a connected client to the hooks below. */
  function Provider(props: { client: SuperLineClient<C, R>; children?: ReactNode }): ReactNode {
    return createElement(Context.Provider, { value: props.client }, props.children)
  }

  /** Access the client from context (throws outside a `<Provider>`). */
  function useClient(): SuperLineClient<C, R> {
    const client = useContext(Context)
    if (!client) throw new Error('useClient must be used within a <Provider>')
    return client
  }

  /** Subscribe to a server-pushed event for the component's lifetime. */
  function useEvent<E extends keyof Events<C, R>>(
    event: E,
    handler: (data: EventData<Events<C, R>[E]>) => void,
  ): void {
    const client = useClient()
    const ref = useRef(handler)
    ref.current = handler
    useEffect(() => client.on(event, (data) => ref.current(data)), [client, event])
  }

  /** Subscribe to a topic and return its latest value (or `undefined` before the first message). */
  function useSubscription<T extends keyof Topics<C, R>>(
    topic: T,
  ): EventData<Topics<C, R>[T]> | undefined {
    const client = useClient()
    const [data, setData] = useState<EventData<Topics<C, R>[T]>>()
    useEffect(() => {
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
    const client = useClient()
    const [state, setState] = useState<RequestState<Output<Requests<C, R>[M]>>>({
      isLoading: false,
    })
    const call = useCallback(
      async (input: ClientInput<Requests<C, R>[M]>) => {
        setState({ isLoading: true })
        try {
          const fn = client[method] as (
            i: ClientInput<Requests<C, R>[M]>,
          ) => Promise<Output<Requests<C, R>[M]>>
          const data = await fn(input)
          setState({ data, isLoading: false })
          return data
        } catch (error) {
          setState({ error, isLoading: false })
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
    set: (value: DocOf<C, N>) => void
    update: (partial: Partial<DocOf<C, N>>) => void
    delete: (path: (string | number)[]) => void
  } {
    type Doc = DocOf<C, N>
    const client = useClient()
    const [data, setData] = useState<Doc>()
    const [deleted, setDeleted] = useState(false)
    const handleRef = useRef<DocHandle<Doc> | undefined>(undefined)
    useEffect(() => {
      const handle = (client.collection(name) as CrdtCollectionHandle<Doc>).open(id)
      handleRef.current = handle
      setData(handle.getSnapshot())
      setDeleted(handle.deleted)
      const unsub = handle.subscribe(() => {
        setData(handle.getSnapshot())
        setDeleted(handle.deleted)
      })
      return () => {
        unsub()
        handle.close()
        handleRef.current = undefined
      }
    }, [client, name, id])
    const set = useCallback((value: Doc) => handleRef.current?.set(value), [])
    const update = useCallback((partial: Partial<Doc>) => handleRef.current?.update(partial), [])
    const del = useCallback((path: (string | number)[]) => handleRef.current?.delete(path), [])
    return { data, deleted, set, update, delete: del }
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
    const client = useClient()
    const queryKey = JSON.stringify(query ?? {}) // stabilize an inline-literal query across renders
    const [rows, setRows] = useState<RowOf<C, N>[]>([])
    const [error, setError] = useState<unknown>()
    const handleRef = useRef<CollectionHandle<RowOf<C, N>> | undefined>(undefined)
    useEffect(() => {
      const q = JSON.parse(queryKey) as CollectionQuery
      const handle = client.collection(name) as CollectionHandle<RowOf<C, N>> // useCollection is the LWW row surface
      handleRef.current = handle
      setError(undefined)
      const sub = handle.subscribe(q)
      const sync = (): void => setRows(sub.rows() as RowOf<C, N>[])
      sync() // reset to the fresh subscription's rows on name/query change
      const off = sub.subscribe(sync)
      void sub.ready.then(sync).catch(setError)
      return () => {
        off()
        sub.close()
        handleRef.current = undefined
      }
    }, [client, name, queryKey])
    const insert = useCallback((row: RowOf<C, N>) => handleRef.current?.insert(row) ?? Promise.resolve(), [])
    const update = useCallback((row: RowOf<C, N>) => handleRef.current?.update(row) ?? Promise.resolve(), [])
    const del = useCallback((id: string) => handleRef.current?.delete(id) ?? Promise.resolve(), [])
    return { rows, error, insert, update, delete: del }
  }

  /**
   * The connection's server-vended, client-visible {@link SuperLineClient.env} (ADR-0012), tracked
   * reactively: `null` until the first push (or for a role with no `env`), then the latest value, re-rendering
   * on every update. Code-only — wire the creds into effects/calls; never render a raw secret.
   */
  function useEnv(): EnvOf<C, R> | null {
    const client = useClient()
    return useSyncExternalStore(
      (onChange) => client.env.subscribe(() => onChange()),
      () => client.env.current,
      () => client.env.current,
    )
  }

  return { Provider, useClient, useEvent, useSubscription, useRequest, useDoc, useCollection, useEnv }
}
