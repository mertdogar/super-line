import {
  INSPECTOR_SUBPROTOCOL,
  jsonSerializer,
  applyQuery,
  matchesFilter,
  type ConnDescriptor,
  type ConnView,
  type InspectedContract,
  type InspectorEnvelope,
  type NodeStat,
  type NodeView,
  type CollectionInfo,
  type CollectionQuery,
} from '@super-line/core'
import type { LiveRowSet, RowSetEvent } from '@super-line/client'

export type InspectorStatus = 'connecting' | 'open' | 'closed'

/** The `collection.change` payload a live row set folds in, narrowed off the inspector event union. */
interface CollectionChange {
  op: 'insert' | 'update' | 'delete'
  id: string
  row?: unknown
}

/** A typed client for the super-line inspector channel (the reserved `superline.inspector.v1` WS). */
export interface InspectorClient {
  getContract(): Promise<InspectedContract>
  getTopology(): Promise<NodeStat[]>
  listConnections(): Promise<ConnDescriptor[]>
  getNode(): Promise<NodeView>
  getConn(id: string): Promise<ConnView>
  /** Declared collections (name + key + advisory references + best-effort JSON Schema) for the schema graph. */
  listCollections(): Promise<CollectionInfo[]>
  /** Browse a collection's rows via the query IR (policy-bypassed, trusted observer). */
  queryCollection(collection: string, query?: CollectionQuery): Promise<unknown[]>
  /** Subscribe to a collection's rows reactively (policy-bypassed, trusted observer). */
  subscribeCollection(collection: string, query?: CollectionQuery): LiveRowSet & { error?: Error }
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
    listCollections: () => request<CollectionInfo[]>('listCollections'),
    queryCollection: (collection, query) => request<unknown[]>('queryCollection', { collection, ...query }),
    subscribeCollection(collection, query = {}) {
      const map = new Map<string, unknown>()
      let view: unknown[] = []
      let inView = new Set<string>()
      let key = 'id'
      let closed = false
      // Changes that land while the initial snapshot is in flight are buffered, then replayed onto it — the
      // snapshot may predate them, so applying them first would be undone by it.
      let buffered: CollectionChange[] | undefined = []
      const listeners = new Set<(ev: RowSetEvent) => void>()

      let resolveReady!: () => void
      let rejectReady!: (err: unknown) => void
      const ready = new Promise<void>((res, rej) => {
        resolveReady = res
        rejectReady = rej
      })
      void ready.catch(() => {}) // the caller may not await it; don't trip unhandled-rejection

      // Recompute the ordered/limited view, then evict rows that fell outside it so `map` stays bounded by
      // `limit` — the honest cost is that a delete inside the window can't backfill from beyond it.
      const recompute = (): Set<string> => {
        view = applyQuery([...map.values()], query)
        const next = new Set(view.map((r) => String((r as Record<string, unknown>)[key])))
        if (query.limit !== undefined && map.size > query.limit) {
          for (const id of map.keys()) if (!next.has(id)) map.delete(id)
        }
        const prev = inView
        inView = next
        return prev
      }

      const apply = (change: CollectionChange): void => {
        const { op, id, row } = change
        if (op === 'delete' || !row) {
          if (!map.delete(id)) return
          if (recompute().has(id)) emit({ type: 'delete', id })
          return
        }
        if (!matchesFilter(query.filter, row)) {
          if (!map.delete(id)) return
          if (recompute().has(id)) emit({ type: 'delete', id })
          return
        }
        const was = map.has(id)
        map.set(id, row)
        // Only notify when the view actually admits (or just dropped) the row — churn beyond the window
        // must not re-render the table.
        if (recompute().has(id) || inView.has(id)) emit({ type: was ? 'update' : 'insert', id, row })
      }

      const emit = (ev: RowSetEvent): void => {
        for (const cb of listeners) cb(ev)
      }

      Promise.all([
        request<CollectionInfo[]>('listCollections'),
        request<unknown[]>('queryCollection', { collection, ...query }),
      ])
        .then(([infos, rows]) => {
          if (closed) return
          key = infos.find((c) => c.name === collection)?.key ?? key
          for (const r of rows) {
            const id = (r as Record<string, unknown>)[key]
            if (typeof id === 'string') map.set(id, r)
          }
          recompute()
          const replay = buffered ?? []
          buffered = undefined // from here changes apply directly
          for (const change of replay) apply(change)
          resolveReady()
        })
        .catch((err) => {
          handle.error = err instanceof Error ? err : new Error(String(err))
          rejectReady(err)
        })

      const onChange = (env: InspectorEnvelope): void => {
        if (env.event.type !== 'collection.change' || env.event.n !== collection) return
        const change: CollectionChange = { op: env.event.op, id: env.event.id, row: env.event.row }
        if (buffered) buffered.push(change)
        else apply(change)
      }
      eventCbs.add(onChange)

      const handle: LiveRowSet & { error?: Error } = {
        rows: () => view,
        subscribe: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        ready,
        close: () => {
          closed = true
          eventCbs.delete(onChange)
          listeners.clear()
        },
      }
      return handle
    },
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
