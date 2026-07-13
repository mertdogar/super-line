import {
  SuperLineError,
  INSPECTOR_ROLE,
  INSPECTOR_SUBPROTOCOL,
  InspectorContract,
  classifyContract,
  eventPayload,
  isCrdtCollection,
  withRowMeta,
  ROW_CREATED_AT,
  ROW_UPDATED_AT,
  type Contract,
  type Schema,
  type Expr,
  type DocListOpts,
  type InspectorEvent,
  type InspectorEnvelope,
  type InspectedContract,
  type ConnView,
  type NodeView,
  type CollectionInfo,
  type CollectionQuery,
} from '@super-line/core'
import type { SuperLinePlugin, PluginChannel, ServerCrdtCollectionHandle } from '@super-line/server'

/** Options for {@link inspector}. */
export interface InspectorOptions {
  /** Field names to mask (`[Redacted]`) in snapshotted payloads / ctx / data. */
  redact?: string[]
}

const encoder = new TextEncoder()
function encodedByteSize(encoded: string | Uint8Array): number {
  return typeof encoded === 'string' ? encoder.encode(encoded).length : encoded.byteLength
}

// Best-effort schema → JSON Schema, via lazy, optional @standard-community/standard-json. The package (and
// per-vendor converter) is optional — a missing/unsupported converter falls back to structure-only.
async function loadJsonConverter(): Promise<((s: Schema) => Promise<unknown>) | null> {
  try {
    const mod = await import('@standard-community/standard-json')
    return mod.toJsonSchema as unknown as (s: Schema) => Promise<unknown>
  } catch {
    return null
  }
}

// getContract structure + best-effort JSON Schema for each message.
async function buildInspectedContract(contract: Contract): Promise<InspectedContract> {
  const toJsonSchema = await loadJsonConverter()
  if (!toJsonSchema) return classifyContract(contract) // converter unavailable -> structure only
  const schemas = new Set<Schema>()
  classifyContract(contract, (s) => {
    schemas.add(s)
    return undefined
  })
  const converted = new Map<Schema, unknown>()
  await Promise.all(
    [...schemas].map((s) =>
      toJsonSchema(s).then(
        (j) => {
          converted.set(s, j)
        },
        () => {}, // unsupported vendor / missing per-vendor converter -> structure-only for this entry
      ),
    ),
  )
  return classifyContract(contract, (s) => converted.get(s))
}

// listCollections: structural info (name/key/references) + best-effort JSON Schema of each row for the graph.
async function buildCollectionInfos(
  contract: Contract,
  infos: { name: string; key: string; references: Record<string, string> }[],
): Promise<CollectionInfo[]> {
  const toJsonSchema = await loadJsonConverter()
  const defs = contract.collections ?? {}
  return Promise.all(
    infos.map(async (info) => {
      const def = defs[info.name]
      const schema = def?.schema
      let json: unknown
      if (toJsonSchema && schema) {
        try {
          json = await toJsonSchema(schema) // may throw sync (no per-vendor converter) or reject — either way, structure-only
        } catch {
          json = undefined
        }
      }
      const crdt = def ? isCrdtCollection(def) : false
      return { ...info, crdt, ...(json !== undefined ? { schema: json } : {}) } satisfies CollectionInfo
    }),
  )
}

// CRDT docs aren't content-queryable — the only filter they support is an id substring. Pull it out of an
// `id` eq/like/ilike predicate (the shape the Control Center's CRDT filter builds), recursing through `and`.
function idContainsOf(filter: Expr | undefined): string | undefined {
  if (!filter) return undefined
  if ((filter.op === 'like' || filter.op === 'ilike') && filter.field === 'id') return filter.pattern.replace(/%/g, '')
  if (filter.op === 'eq' && filter.field === 'id' && typeof filter.value === 'string') return filter.value
  if (filter.op === 'and') for (const a of filter.args) {
    const r = idContainsOf(a)
    if (r) return r
  }
  return undefined
}

// Map a Control Center orderBy field to the CRDT store's sortable dimensions (id / created / updated).
function crdtSortBy(field: string | undefined): 'id' | 'createdAt' | 'updatedAt' | undefined {
  if (field === 'id') return 'id'
  if (field === ROW_CREATED_AT) return 'createdAt'
  if (field === ROW_UPDATED_AT) return 'updatedAt'
  return undefined
}

/**
 * The Control Center inspector, packaged as a plugin. It taps every request/event, snapshots +
 * field-redacts the payloads, and publishes them (cluster-wide) on its own plugin channel; and it declares a
 * plugin-owned, observer-invisible connection class (the `superline.inspector.v1` subprotocol) that serves
 * Control Center clients the `InspectorContract` — `getContract`, `getTopology`, `getConn`, … and the
 * `events` feed. Register it with `plugins: [inspector()]`. **Dev / trusted-network only.**
 */
export function inspector(opts: InspectorOptions = {}): SuperLinePlugin {
  const redact = new Set(opts.redact ?? [])

  // best-effort, never-throwing snapshot of a value for display (node-local); masks redacted field names
  function safeSnapshot(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (value === null) return null
    const t = typeof value
    if (t === 'bigint') return `${(value as bigint).toString()}n`
    if (t === 'function') return '[Function]'
    if (t === 'symbol') return (value as symbol).toString()
    if (t !== 'object') return value // string | number | boolean | undefined
    const obj = value as object
    if (obj instanceof Date) return obj.toISOString()
    if (seen.has(obj)) return '[Circular]'
    if (depth >= 6) return '[MaxDepth]'
    seen.add(obj)
    try {
      if (Array.isArray(obj)) return obj.slice(0, 1000).map((v) => safeSnapshot(v, depth + 1, seen))
      const ctor = (Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null)?.constructor?.name
      const out: Record<string, unknown> = {}
      if (ctor && ctor !== 'Object') out['#type'] = ctor
      for (const [k, v] of Object.entries(obj)) {
        out[k] = redact.has(k) ? '[Redacted]' : safeSnapshot(v, depth + 1, seen)
      }
      return out
    } finally {
      seen.delete(obj)
    }
  }

  // Replace an event's payload field(s) with a redacted safe snapshot — the display-only copy put on the wire.
  function snapshotEvent(event: InspectorEvent): InspectorEvent {
    switch (event.type) {
      case 'msg.request':
      case 'msg.serverRequest':
        return { ...event, input: safeSnapshot(event.input) }
      case 'msg.response':
      case 'msg.serverReply':
        return event.ok ? { ...event, output: safeSnapshot(event.output) } : event
      case 'msg.event':
      case 'msg.broadcast':
      case 'msg.publish':
        return { ...event, data: safeSnapshot(event.data) }
      case 'collection.sub':
        return { ...event, query: safeSnapshot(event.query) }
      case 'collection.write':
        return { ...event, ops: safeSnapshot(event.ops) }
      case 'collection.change':
        return { ...event, row: safeSnapshot(event.row) }
      case 'crdt.open':
      case 'crdt.write':
        return event.ok ? { ...event, snapshot: safeSnapshot(event.snapshot) } : event
      default:
        return event
    }
  }

  // captured in setup(), used by the tap (which doesn't receive the context)
  let channel: PluginChannel | undefined
  let originNodeId = ''
  let encode: (value: unknown) => string | Uint8Array = (v) => JSON.stringify(v)

  return {
    name: 'inspector',
    setup(ctx) {
      channel = ctx.channel('events') // the CC's `events` feed rides this plugin channel (cluster-wide)
      originNodeId = ctx.instanceId
      encode = (v) => ctx.serializer.encode(v)
    },
    onEvent(event) {
      if (!channel) return
      const snapped = snapshotEvent(event)
      const payload = eventPayload(snapped)
      const envelope: InspectorEnvelope = {
        event: snapped,
        ts: Date.now(),
        originNodeId,
        byteSize: payload === undefined ? undefined : encodedByteSize(encode(payload)),
      }
      channel.publish(envelope)
    },
    connection: {
      role: INSPECTOR_ROLE,
      subprotocol: INSPECTOR_SUBPROTOCOL,
      contract: InspectorContract,
      handlers: (ctx) => ({
        getContract: () => buildInspectedContract(ctx.contract),
        getTopology: () => ctx.cluster.topology(),
        listConnections: () => ctx.cluster.connections(),
        getNode: async () =>
          ({ nodeId: ctx.instanceId, nodeName: ctx.nodeName, rooms: ctx.local.rooms, topics: ctx.local.topics }) satisfies NodeView,
        getConn: async (input) => {
          const id = (input as { id?: string } | undefined)?.id
          if (!id) throw new SuperLineError('BAD_REQUEST', 'getConn requires an id')
          const local = ctx.conns.find((cn) => cn.id === id)
          if (local) {
            return {
              descriptor: ctx.describe(local),
              ctx: safeSnapshot(local.ctx),
              data: safeSnapshot(local.data),
              ctxAvailable: true,
            } satisfies ConnView
          }
          const remote = await ctx.connectionById(id) // on another node: descriptor only, no ctx
          if (!remote) throw new SuperLineError('NOT_FOUND', `Unknown connection: ${id}`)
          return { descriptor: remote, ctxAvailable: false } satisfies ConnView
        },
        listCollections: () => buildCollectionInfos(ctx.contract, ctx.collectionInfos()),
        queryCollection: async (input) => {
          const { collection, ...query } = input as { collection: string } & CollectionQuery
          const def = ctx.contract.collections?.[collection]
          if (!def) throw new SuperLineError('NOT_FOUND', `Unknown collection: ${collection}`)
          if (isCrdtCollection(def)) {
            // CRDT document collection: open-by-id, not row-queryable — synthesize `{ id, ...snapshot }` rows
            // from the doc enumeration so the Collections view can browse them like any table. Filtering is
            // id-substring only; sorting is by id / created / updated. The per-doc created/updated ride each
            // DocSummary, so surface them under the reserved keys too.
            const handle = ctx.collection(collection) as unknown as ServerCrdtCollectionHandle
            const opts: DocListOpts = { limit: query.limit, offset: query.offset }
            const idContains = idContainsOf(query.filter)
            if (idContains) opts.idContains = idContains
            const sortBy = crdtSortBy(query.orderBy?.[0]?.field)
            if (sortBy) opts.sort = { by: sortBy, dir: query.orderBy?.[0]?.dir === 'desc' ? 'desc' : 'asc' }
            const docs = await handle.list(opts)
            const rows = await Promise.all(
              docs.map(async (d) =>
                withRowMeta(
                  { id: d.id, ...((await handle.read(d.id)) as Record<string, unknown> | undefined) },
                  { createdAt: d.createdAt, updatedAt: d.updatedAt },
                ),
              ),
            )
            return rows.map((r) => safeSnapshot(r))
          }
          const handle = ctx.collection(collection) // ACL/policy bypassed — the inspector is a trusted observer
          const key = def.key ?? 'id'
          const idOf = (r: Record<string, unknown>): string => String(r[key])
          const tsSort = query.orderBy?.find((o) => o.field === ROW_CREATED_AT || o.field === ROW_UPDATED_AT)
          if (tsSort && handle.rowMeta) {
            // created/updated live outside the row data, so the backend can't ORDER BY them — scan the filtered
            // set, merge the store timestamps, sort, then slice the requested page (inspector-side, dev-scale).
            const all = (await handle.snapshot({ filter: query.filter })) as Record<string, unknown>[]
            const meta = await handle.rowMeta(all.map(idOf))
            const merged = all.map((r) => withRowMeta(r, meta[idOf(r)]) as Record<string, unknown>)
            const dir = tsSort.dir === 'desc' ? -1 : 1
            merged.sort((a, b) => (((a[tsSort.field] as number) ?? 0) - ((b[tsSort.field] as number) ?? 0)) * dir)
            const offset = query.offset ?? 0
            const page = query.limit != null ? merged.slice(offset, offset + query.limit) : merged.slice(offset)
            return page.map((r) => safeSnapshot(r))
          }
          const rows = (await handle.snapshot(query)) as Record<string, unknown>[] // filter + schema-field sort push down
          const meta = handle.rowMeta ? await handle.rowMeta(rows.map(idOf)) : {}
          return rows.map((r) => safeSnapshot(withRowMeta(r, meta[idOf(r)])))
        },
      }),
    },
  }
}
