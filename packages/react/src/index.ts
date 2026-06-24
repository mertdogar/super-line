import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
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
} from '@super-line/core'
import type { ResourceHandle, SuperLineClient } from '@super-line/client'

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
   * Open a Store Resource and track it reactively: returns its latest `data` (`undefined` until the
   * catch-up snapshot arrives) plus `set`/`update`/`delete` to write through. `data` is untyped — stores are
   * off-contract (ADR-0003) — so pass `T` to assert its shape. The handle is closed on unmount.
   */
  function useResource<T = unknown>(
    name: string,
    id: string,
  ): {
    data: T | undefined
    set: (value: T) => void
    update: (partial: Partial<T>) => void
    delete: (path: (string | number)[]) => void
  } {
    const client = useClient()
    const [data, setData] = useState<T>()
    const handleRef = useRef<ResourceHandle | undefined>(undefined)
    useEffect(() => {
      const handle = client.store(name).open(id)
      handleRef.current = handle
      setData(handle.getSnapshot() as T | undefined) // reset to the fresh handle's state on id/name change
      const unsub = handle.subscribe(() => setData(handle.getSnapshot() as T | undefined))
      return () => {
        unsub()
        handle.close()
        handleRef.current = undefined
      }
    }, [client, name, id])
    const set = useCallback((value: T) => handleRef.current?.set(value), [])
    const update = useCallback((partial: Partial<T>) => handleRef.current?.update(partial), [])
    const del = useCallback((path: (string | number)[]) => handleRef.current?.delete(path), [])
    return { data, set, update, delete: del }
  }

  return { Provider, useClient, useEvent, useSubscription, useRequest, useResource }
}
