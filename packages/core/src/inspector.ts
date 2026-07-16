import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ConnDescriptor, NodeStat } from './adapter.js'
import { defineContract } from './contract.js'
import type { Contract, Directional, Schema } from './contract.js'
import type { CollectionQuery } from './query.js'

/** WS subprotocol the Control Center connects with; the server short-circuits auth for it. */
export const INSPECTOR_SUBPROTOCOL = 'superline.inspector.v1'

/** The reserved role minted for an inspector connection. */
export const INSPECTOR_ROLE = 'inspector'

/** How a contract message is used on the wire. */
export type MessageFlavor = 'request' | 'event' | 'topic' | 'serverRequest'

/** One message in an {@link InspectedContract}. Schemas are best-effort JSON Schema, omitted when unavailable. */
export interface InspectedMessage {
  /** The message name (its key in the contract). */
  name: string
  /** How the message is used. */
  flavor: MessageFlavor
  /** Best-effort JSON Schema of the request/server-request input. */
  input?: unknown
  /** Best-effort JSON Schema of the request/server-request output. */
  output?: unknown
  /** Best-effort JSON Schema of an event/topic payload. */
  payload?: unknown
}

/** The two directions of a `shared` or role block, flattened for display. */
export interface InspectedDirectional {
  clientToServer: InspectedMessage[]
  serverToClient: InspectedMessage[]
}

/** A serializable projection of a {@link Contract}'s structure — what `getContract` returns. */
export interface InspectedContract {
  shared: InspectedDirectional
  roles: Record<string, InspectedDirectional>
}

/** The connected node's local view — what `getNode` returns. */
export interface NodeView {
  nodeId: string
  nodeName: string
  rooms: string[]
  topics: string[]
}

/** A connection's detail — what `getConn` returns. ctx/data/env are node-local and best-effort safe-serialized. */
export interface ConnView {
  descriptor: ConnDescriptor
  /** Safe-serialized auth ctx; present only when the conn is on the queried node. */
  ctx?: unknown
  /** Safe-serialized `conn.data`; present only when the conn is on the queried node. */
  data?: unknown
  /**
   * Safe-serialized `conn.env` (ADR-0012), MASKED: values hidden unless the key is allow-listed via the
   * inspector's `revealEnvKeys` (env holds credentials, so it is masked by default — the opposite of
   * ctx/data). Present only when the conn is on the queried node.
   */
  env?: unknown
  /** Whether ctx/data/env could be read (false for conns on another node). */
  ctxAvailable: boolean
}

/**
 * A declared collection — what `listCollections` returns, for the Control Center schema graph. `references`
 * are the advisory foreign keys (graph edges); `schema` is best-effort JSON Schema of the row (node fields),
 * omitted when no converter is available.
 */
export interface CollectionInfo {
  name: string
  key: string
  references: Record<string, string>
  schema?: unknown
  /** True for CRDT document collections — they're id-queryable only (no schema-field filters), so the CC degrades the filter/sort UI. */
  crdt: boolean
}

/** A failed response/reply, carried on `msg.response` / `msg.serverReply`. */
export interface MessageError {
  code: string
  message: string
}

/**
 * A live event pushed on the `events` topic, fanned out cluster-wide. Lifecycle events
 * (connect/disconnect/room/topic) are always emitted when inspector is on; `msg.*` events
 * carry actual message traffic and are only emitted when inspector is on. Message payloads are
 * safe-serialized and field-redacted (via the `inspector.redact` list) before they cross the bus.
 */
export type InspectorEvent =
  | { type: 'connect'; descriptor: ConnDescriptor }
  | { type: 'disconnect'; connId: string; nodeId: string; userId?: string }
  | { type: 'room.add'; connId: string; room: string }
  | { type: 'room.remove'; connId: string; room: string }
  | { type: 'topic.sub'; connId: string; topic: string }
  | { type: 'topic.unsub'; connId: string; topic: string }
  // client→server request and its response (input/output redacted). `reqId` is the per-connection
  // frame id, so the Control Center can pair a response with its request to compute latency.
  | { type: 'msg.request'; connId: string; role: string; name: string; input: unknown; reqId: number }
  | { type: 'msg.response'; connId: string; name: string; ok: boolean; output?: unknown; error?: MessageError; reqId: number }
  // server→client event to a single connection (conn.emit / toConn().emit)
  | { type: 'msg.event'; target: string; name: string; data: unknown }
  // room.broadcast and topic publish
  | { type: 'msg.broadcast'; room: string; name: string; data: unknown }
  | { type: 'msg.publish'; topic: string; data: unknown }
  // server→client request and the client's reply. `reqId` pairs reply↔request, as above.
  | { type: 'msg.serverRequest'; target: string; name: string; input: unknown; reqId: number }
  | { type: 'msg.serverReply'; target: string; name: string; ok: boolean; output?: unknown; error?: MessageError; reqId: number }
  // Collection frames (typed rows, ADR-0006). Client ops carry the originating `connId`; row-change fan-out is
  // collection-scoped — one event per applied change, like `msg.broadcast`. `query`/`ops`/`row` are redacted.
  | { type: 'collection.sub'; connId: string; role: string; n: string; sid: number; query: unknown; ok: boolean; error?: MessageError; count?: number }
  | { type: 'collection.unsub'; connId: string; n: string; sid: number }
  | { type: 'collection.write'; connId: string; role: string; ops: unknown; ok: boolean; error?: MessageError }
  | { type: 'collection.change'; n: string; op: 'insert' | 'update' | 'delete'; id: string; origin?: string; row?: unknown }
  // CRDT document frames (ADR-0007). The delta is opaque base64 Yjs binary — never surfaced; `open`/`write` carry the
  // plaintext snapshot the server already computed (read policy / validate-before-commit), `change` only the writer
  // origin + delta byte size.
  | { type: 'crdt.open'; connId: string; n: string; id: string; ok: boolean; error?: MessageError; snapshot?: unknown }
  | { type: 'crdt.write'; connId: string; n: string; id: string; origin: string; deltaBytes: number; ok: boolean; error?: MessageError; snapshot?: unknown }
  | { type: 'crdt.close'; connId: string; n: string; id: string }
  | { type: 'crdt.change'; n: string; id: string; origin: string; deltaBytes: number }
  | { type: 'crdt.delete'; n: string; id: string }
  // server-vended per-connection env set/updated (ADR-0012). `env` is MASKED before crossing the bus
  // (default-mask + `revealEnvKeys` allow-list), because it holds credentials — unlike ctx/data's deny-list.
  | { type: 'env.set'; connId: string; nodeId: string; env: unknown }

/**
 * The public taxonomy a plugin `onEvent` tap observes: an {@link InspectorEvent} with live
 * (un-snapshotted, un-redacted) payload references, fired synchronously at the emit site. The
 * inspector is itself one tap consumer; it snapshots + redacts before its own events cross the bus.
 * Same shape as `InspectorEvent` (the envelope is added only by the inspector consumer, not the tap).
 */
export type TapEvent = InspectorEvent

/**
 * Cross-cutting metadata about one inspection record, wrapping the {@link InspectorEvent} it
 * describes. The event stays a pure "what happened" union; the envelope carries when the origin
 * node emitted it, how big the (redacted) payload snapshot was, and which node emitted it. This is
 * what travels on the inspector `events` topic.
 */
export interface InspectorEnvelope {
  event: InspectorEvent
  /** Origin-node emit time (epoch ms). */
  ts: number
  /** Encoded byte size of the redacted payload snapshot; absent for events with no payload. */
  byteSize?: number
  /** Id of the node that emitted the event. */
  originNodeId: string
}

/** The inspectable payload of an event (input/output/data/perms), or undefined for events with none. */
export function eventPayload(event: InspectorEvent): unknown {
  switch (event.type) {
    case 'msg.request':
    case 'msg.serverRequest':
      return event.input
    case 'msg.response':
    case 'msg.serverReply':
      return event.ok ? event.output : event.error
    case 'msg.event':
    case 'msg.broadcast':
    case 'msg.publish':
      return event.data
    case 'collection.sub':
      return event.query
    case 'collection.write':
      return event.ops
    case 'collection.change':
      return event.row
    case 'env.set':
      return event.env
    case 'crdt.open':
    case 'crdt.write':
      return event.ok ? event.snapshot : event.error
    default:
      return undefined
  }
}

// Passthrough Standard Schema: carries TS types for inference, no-op at runtime. The inspector
// channel is library-owned and trusted, so validation is intentionally a no-op.
function s<T>(): StandardSchemaV1<T, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'super-line-inspector',
      validate: (value: unknown) => ({ value: value as T }),
    },
  }
}

/**
 * The fixed, library-owned contract describing the inspector surface. Identical for every
 * super-line app, so it is NOT merged into the user's contract — inbound dispatch routes an
 * inspector connection against this instead, which keeps the user's `RoleOf<C>` clean.
 */
export const InspectorContract = defineContract({
  roles: {
    inspector: {
      clientToServer: {
        getContract: { input: s<void>(), output: s<InspectedContract>() },
        getTopology: { input: s<void>(), output: s<NodeStat[]>() },
        listConnections: { input: s<void>(), output: s<ConnDescriptor[]>() },
        getNode: { input: s<void>(), output: s<NodeView>() },
        getConn: { input: s<{ id: string }>(), output: s<ConnView>() },
        listCollections: { input: s<void>(), output: s<CollectionInfo[]>() },
        queryCollection: { input: s<{ collection: string } & CollectionQuery>(), output: s<unknown[]>() },
      },
      serverToClient: {
        events: { payload: s<InspectorEnvelope>(), subscribe: true },
      },
    },
  },
})

/** A schema → JSON Schema converter (best-effort). Supplied by the server in slice 3. */
export type SchemaConverter = (schema: Schema) => unknown

// attach converted schemas, omitting any the converter can't produce (structure-only for that field)
function withSchemas(
  msg: InspectedMessage,
  schemas: Record<string, Schema>,
  convert?: SchemaConverter,
): InspectedMessage {
  if (!convert) return msg
  for (const [key, schema] of Object.entries(schemas)) {
    const value = convert(schema)
    if (value !== undefined) (msg as unknown as Record<string, unknown>)[key] = value
  }
  return msg
}

function classifyDirectional(d: Directional | undefined, convert?: SchemaConverter): InspectedDirectional {
  const clientToServer: InspectedMessage[] = []
  const serverToClient: InspectedMessage[] = []
  for (const [name, def] of Object.entries(d?.clientToServer ?? {})) {
    clientToServer.push(
      withSchemas({ name, flavor: 'request' }, { input: def.input, output: def.output }, convert),
    )
  }
  for (const [name, def] of Object.entries(d?.serverToClient ?? {})) {
    if ('input' in def) {
      serverToClient.push(
        withSchemas({ name, flavor: 'serverRequest' }, { input: def.input, output: def.output }, convert),
      )
    } else {
      serverToClient.push(
        withSchemas(
          { name, flavor: def.subscribe === true ? 'topic' : 'event' },
          { payload: def.payload },
          convert,
        ),
      )
    }
  }
  return { clientToServer, serverToClient }
}

/**
 * Walk a contract and project its structure: roles × directions × message names × flavors.
 * Pass `convert` to attach best-effort JSON Schema to each message; omit it for structure only.
 */
export function classifyContract(contract: Contract, convert?: SchemaConverter): InspectedContract {
  const roles: Record<string, InspectedDirectional> = {}
  for (const [role, block] of Object.entries(contract.roles)) {
    roles[role] = classifyDirectional(block, convert)
  }
  return { shared: classifyDirectional(contract.shared, convert), roles }
}
