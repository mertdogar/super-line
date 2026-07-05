import {
  SuperLineError,
  INSPECTOR_ROLE,
  INSPECTOR_SUBPROTOCOL,
  InspectorContract,
  classifyContract,
  eventPayload,
  type Contract,
  type Schema,
  type InspectorEvent,
  type InspectorEnvelope,
  type InspectedContract,
  type ConnView,
  type NodeView,
  type StoreResourceView,
  type CollectionInfo,
  type CollectionQuery,
  type ListOpts,
  type SearchOpts,
} from '@super-line/core'
import type { SuperLinePlugin, PluginChannel } from '@super-line/server'

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
      const schema = defs[info.name]?.schema
      let json: unknown
      if (toJsonSchema && schema) {
        try {
          json = await toJsonSchema(schema) // may throw sync (no per-vendor converter) or reject — either way, structure-only
        } catch {
          json = undefined
        }
      }
      return { ...info, ...(json !== undefined ? { schema: json } : {}) } satisfies CollectionInfo
    }),
  )
}

/**
 * The Control Center inspector, packaged as a plugin. It taps every request/event/store write, snapshots +
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
      case 'store.write':
        return { ...event, data: safeSnapshot(event.data) }
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
        listStores: async () => ctx.storeInfos(),
        listResources: async (input) => {
          const { store: name, ...opts } = input as { store: string } & ListOpts
          if (!ctx.storeInfos().some((s) => s.name === name)) throw new SuperLineError('NOT_FOUND', `Unknown store: ${name}`)
          return ctx.store(name).list(opts)
        },
        searchPrincipals: async (input) => {
          const { store: name, ...opts } = input as { store: string } & SearchOpts
          if (!ctx.storeInfos().some((s) => s.name === name)) throw new SuperLineError('NOT_FOUND', `Unknown store: ${name}`)
          return ctx.store(name).searchPrincipals(opts)
        },
        readResource: async (input) => {
          const { store: name, id } = input as { store: string; id: string }
          if (!ctx.storeInfos().some((s) => s.name === name)) throw new SuperLineError('NOT_FOUND', `Unknown store: ${name}`)
          const handle = ctx.store(name)
          const resource = await handle.read(id) // ACL bypassed — the inspector is a trusted observer
          if (!resource) throw new SuperLineError('NOT_FOUND', `No resource: ${name}/${id}`)
          let data = resource.data
          try {
            const replica = handle.open(id) // materialize a readable snapshot (LWW: plain; CRDT: decoded)
            data = replica.getSnapshot()
            replica.close()
          } catch {
            // store has no reactive open() — the plain resource data is the snapshot
          }
          return { data: safeSnapshot(data), accessRules: resource.accessRules } satisfies StoreResourceView
        },
        listCollections: () => buildCollectionInfos(ctx.contract, ctx.collectionInfos()),
        queryCollection: async (input) => {
          const { collection, ...query } = input as { collection: string } & CollectionQuery
          if (!ctx.collectionInfos().some((c) => c.name === collection))
            throw new SuperLineError('NOT_FOUND', `Unknown collection: ${collection}`)
          const rows = await ctx.collection(collection).snapshot(query) // ACL/policy bypassed — the inspector is a trusted observer
          return rows.map((r) => safeSnapshot(r))
        },
      }),
    },
  }
}
