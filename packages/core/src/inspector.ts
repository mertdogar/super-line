import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { ConnDescriptor, NodeStat } from './adapter.js'
import { defineContract } from './contract.js'
import type { Contract, Directional, Schema } from './contract.js'

/** WS subprotocol the Control Center connects with; the server short-circuits auth for it. */
export const INSPECTOR_SUBPROTOCOL = 'superline.inspector.v1'

/** The reserved role minted for an inspector connection. */
export const INSPECTOR_ROLE = 'inspector'

/** How a contract message is used on the wire. */
export type MessageFlavor = 'request' | 'event' | 'topic' | 'serverRequest' | 'serverEvent'

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
  /** Best-effort JSON Schema of an event/topic/serverToServer payload. */
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
  serverToServer: InspectedMessage[]
}

/** The connected node's local view — what `getNode` returns. */
export interface NodeView {
  nodeId: string
  rooms: string[]
  topics: string[]
}

/** A connection's detail — what `getConn` returns. ctx/data are node-local and best-effort safe-serialized. */
export interface ConnView {
  descriptor: ConnDescriptor
  /** Safe-serialized auth ctx; present only when the conn is on the queried node. */
  ctx?: unknown
  /** Safe-serialized `conn.data`; present only when the conn is on the queried node. */
  data?: unknown
  /** Whether ctx/data could be read (false for conns on another node). */
  ctxAvailable: boolean
}

/** A live topology event pushed on the `events` topic, fanned out cluster-wide. */
export type InspectorEvent =
  | { type: 'connect'; descriptor: ConnDescriptor }
  | { type: 'disconnect'; connId: string; nodeId: string }
  | { type: 'room.add'; connId: string; room: string }
  | { type: 'room.remove'; connId: string; room: string }
  | { type: 'topic.sub'; connId: string; topic: string }
  | { type: 'topic.unsub'; connId: string; topic: string }

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
      },
      serverToClient: {
        events: { payload: s<InspectorEvent>(), subscribe: true },
      },
    },
  },
})

/** A schema → JSON Schema converter (best-effort). Supplied by the server in slice 3. */
export type SchemaConverter = (schema: Schema) => unknown

function classifyDirectional(d: Directional | undefined, convert?: SchemaConverter): InspectedDirectional {
  const clientToServer: InspectedMessage[] = []
  const serverToClient: InspectedMessage[] = []
  for (const [name, def] of Object.entries(d?.clientToServer ?? {})) {
    clientToServer.push({
      name,
      flavor: 'request',
      ...(convert && { input: convert(def.input), output: convert(def.output) }),
    })
  }
  for (const [name, def] of Object.entries(d?.serverToClient ?? {})) {
    if ('input' in def) {
      serverToClient.push({
        name,
        flavor: 'serverRequest',
        ...(convert && { input: convert(def.input), output: convert(def.output) }),
      })
    } else {
      serverToClient.push({
        name,
        flavor: def.subscribe === true ? 'topic' : 'event',
        ...(convert && { payload: convert(def.payload) }),
      })
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
  const serverToServer: InspectedMessage[] = []
  for (const [name, schema] of Object.entries(contract.serverToServer ?? {})) {
    serverToServer.push({ name, flavor: 'serverEvent', ...(convert && { payload: convert(schema) }) })
  }
  return { shared: classifyDirectional(contract.shared, convert), roles, serverToServer }
}
