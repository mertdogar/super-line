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
import type { Contract, InferIn, InferOut } from '@super-line/core'
import type { Client } from '@super-line/client'

type Messages<C extends Contract> = NonNullable<C['messages']>
type Events<C extends Contract> = NonNullable<C['events']>
type Topics<C extends Contract> = NonNullable<C['topics']>

export interface RequestState<T> {
  data?: T
  error?: unknown
  isLoading: boolean
}

// Bind a set of typed React hooks to a contract. Pass a connected client via <Provider>.
export function createSocketReact<C extends Contract>() {
  const Context = createContext<Client<C> | null>(null)

  function Provider(props: { client: Client<C>; children?: ReactNode }): ReactNode {
    return createElement(Context.Provider, { value: props.client }, props.children)
  }

  function useClient(): Client<C> {
    const client = useContext(Context)
    if (!client) throw new Error('useClient must be used within a <Provider>')
    return client
  }

  function useEvent<E extends keyof Events<C>>(
    event: E,
    handler: (data: InferOut<Events<C>[E]>) => void,
  ): void {
    const client = useClient()
    const ref = useRef(handler)
    ref.current = handler
    useEffect(() => client.on(event, (data) => ref.current(data)), [client, event])
  }

  function useSubscription<T extends keyof Topics<C>>(
    topic: T,
  ): InferOut<Topics<C>[T]> | undefined {
    const client = useClient()
    const [data, setData] = useState<InferOut<Topics<C>[T]>>()
    useEffect(() => {
      const sub = client.subscribe(topic, setData)
      return () => sub.unsubscribe()
    }, [client, topic])
    return data
  }

  function useRequest<M extends keyof Messages<C>>(
    method: M,
  ): RequestState<InferOut<Messages<C>[M]['output']>> & {
    call: (input: InferIn<Messages<C>[M]['input']>) => Promise<InferOut<Messages<C>[M]['output']>>
  } {
    const client = useClient()
    const [state, setState] = useState<RequestState<InferOut<Messages<C>[M]['output']>>>({
      isLoading: false,
    })
    const call = useCallback(
      async (input: InferIn<Messages<C>[M]['input']>) => {
        setState({ isLoading: true })
        try {
          const fn = client[method] as (
            i: InferIn<Messages<C>[M]['input']>,
          ) => Promise<InferOut<Messages<C>[M]['output']>>
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

  return { Provider, useClient, useEvent, useSubscription, useRequest }
}
