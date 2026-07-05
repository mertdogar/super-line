import {
  INSPECTOR_SUBPROTOCOL,
  jsonSerializer,
  type ConnDescriptor,
  type ConnView,
  type InspectedContract,
  type InspectorEnvelope,
  type ListOpts,
  type NodeStat,
  type NodeView,
  type ResourceSummary,
  type SearchOpts,
  type StoreInfo,
  type StoreResourceView,
  type CollectionInfo,
  type CollectionQuery,
} from '@super-line/core'

export type InspectorStatus = 'connecting' | 'open' | 'closed'

/** A typed client for the super-line inspector channel (the reserved `superline.inspector.v1` WS). */
export interface InspectorClient {
  getContract(): Promise<InspectedContract>
  getTopology(): Promise<NodeStat[]>
  listConnections(): Promise<ConnDescriptor[]>
  getNode(): Promise<NodeView>
  getConn(id: string): Promise<ConnView>
  listStores(): Promise<StoreInfo[]>
  /** Server-side filtered / sorted / paginated Resource summaries for one store. */
  listResources(store: string, opts?: ListOpts): Promise<ResourceSummary[]>
  /** Store-global principal lookup (substring, principal-ascending) for the Users filter. */
  searchPrincipals(store: string, opts?: SearchOpts): Promise<string[]>
  readResource(store: string, id: string): Promise<StoreResourceView>
  /** Declared collections (name + key + advisory references + best-effort JSON Schema) for the schema graph. */
  listCollections(): Promise<CollectionInfo[]>
  /** Browse a collection's rows via the query IR (policy-bypassed, trusted observer). */
  queryCollection(collection: string, query?: CollectionQuery): Promise<unknown[]>
  /** Subscribe to live inspection records. Returns an unsubscribe fn. */
  onEvent(cb: (env: InspectorEnvelope) => void): () => void
  /** Observe connection status (called immediately with the current status). Returns an unsubscribe fn. */
  onStatus(cb: (status: InspectorStatus) => void): () => void
  close(): void
}

interface Waiter {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

type WireFrame = { t: string; i?: number; c?: string; d?: unknown; code?: string; m?: string }

export interface InspectorOptions {
  url: string
  /** WebSocket implementation (defaults to `globalThis.WebSocket`). */
  WebSocket?: typeof WebSocket
  /** Auto-reconnect on drop. Defaults to `true`. */
  reconnect?: boolean
}

export function createInspector(opts: InspectorOptions): InspectorClient {
  const resolved = opts.WebSocket ?? (globalThis.WebSocket as typeof WebSocket | undefined)
  if (!resolved) throw new Error('No WebSocket implementation found; pass opts.WebSocket')
  const WS: typeof WebSocket = resolved
  const reconnect = opts.reconnect ?? true

  const eventCbs = new Set<(env: InspectorEnvelope) => void>()
  const statusCbs = new Set<(status: InspectorStatus) => void>()
  const waiters = new Map<number, Waiter>()
  let ws: WebSocket
  let nextId = 1
  let closed = false
  let status: InspectorStatus = 'connecting'
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function setStatus(next: InspectorStatus): void {
    status = next
    for (const cb of statusCbs) cb(next)
  }

  function connect(): void {
    setStatus('connecting')
    ws = new WS(opts.url, INSPECTOR_SUBPROTOCOL)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      setStatus('open')
      ws.send(jsonSerializer.encode({ t: 'sub', i: nextId++, c: 'events' })) // subscribe live events
    }
    ws.onmessage = (event: MessageEvent) => onMessage(event.data as string | ArrayBuffer)
    ws.onclose = () => {
      for (const [, w] of waiters) w.reject(new Error('Inspector disconnected'))
      waiters.clear()
      if (closed || !reconnect) {
        setStatus('closed')
        return
      }
      setStatus('closed')
      reconnectTimer = setTimeout(connect, 1000)
    }
    ws.onerror = () => {} // the close handler drives reconnect
  }

  function onMessage(data: string | ArrayBuffer): void {
    let frame: WireFrame
    try {
      frame = jsonSerializer.decode(
        typeof data === 'string' ? data : new Uint8Array(data),
      ) as WireFrame
    } catch {
      return
    }
    if (frame.t === 'pub' && frame.c === 'events') {
      for (const cb of eventCbs) cb(frame.d as InspectorEnvelope)
      return
    }
    if (frame.i === undefined) return
    const w = waiters.get(frame.i)
    if (!w) return
    waiters.delete(frame.i)
    if (frame.t === 'res') w.resolve(frame.d)
    else if (frame.t === 'err') w.reject(new Error(frame.code ?? 'INSPECTOR_ERROR'))
  }

  function request<T>(method: string, input?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (status !== 'open') {
        reject(new Error('Inspector not connected'))
        return
      }
      const id = nextId++
      waiters.set(id, { resolve: resolve as (value: unknown) => void, reject })
      ws.send(jsonSerializer.encode({ t: 'req', i: id, m: method, d: input }))
    })
  }

  connect()

  return {
    getContract: () => request<InspectedContract>('getContract'),
    getTopology: () => request<NodeStat[]>('getTopology'),
    listConnections: () => request<ConnDescriptor[]>('listConnections'),
    getNode: () => request<NodeView>('getNode'),
    getConn: (id) => request<ConnView>('getConn', { id }),
    listStores: () => request<StoreInfo[]>('listStores'),
    listResources: (store, opts) => request<ResourceSummary[]>('listResources', { store, ...opts }),
    searchPrincipals: (store, opts) => request<string[]>('searchPrincipals', { store, ...opts }),
    readResource: (store, id) => request<StoreResourceView>('readResource', { store, id }),
    listCollections: () => request<CollectionInfo[]>('listCollections'),
    queryCollection: (collection, query) => request<unknown[]>('queryCollection', { collection, ...query }),
    onEvent(cb) {
      eventCbs.add(cb)
      return () => eventCbs.delete(cb)
    },
    onStatus(cb) {
      statusCbs.add(cb)
      cb(status)
      return () => statusCbs.delete(cb)
    },
    close() {
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    },
  }
}
