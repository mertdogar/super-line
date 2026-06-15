import type { StandardSchemaV1 } from '@standard-schema/spec'
import { SocketError } from './errors.js'

/** Any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType…). */
export type Schema = StandardSchemaV1

/**
 * A client→server request (request/response). The client sends `input`; the
 * server validates it, runs the handler, and replies with `output`.
 * Fire-and-forget signals (no `output`) are not supported yet.
 */
export interface RequestDef {
  /** Schema for the request payload the client sends. */
  input: Schema
  /** Schema for the reply the server returns. */
  output: Schema
}

/**
 * A server→client message. With `subscribe: true` it becomes a client-subscribable
 * **topic**; otherwise it is a server-pushed **event**.
 */
export interface ServerMessageDef {
  /** Schema for the message body. */
  payload: Schema
  /** When `true`, clients opt in via `client.subscribe(...)` (a topic). Omit for a push event. */
  subscribe?: boolean
}

/**
 * A server→client request (request/response). The server sends `input`; the
 * client's `implement` handler returns `output`. Lives in `serverToClient`
 * alongside events and topics, distinguished by having `input`.
 */
export interface ServerRequestDef {
  /** Schema for the request payload the server sends. */
  input: Schema
  /** Schema for the reply the client returns. */
  output: Schema
}

/** A `serverToClient` entry: a push event, a subscribable topic, or a server→client request. */
export type ServerEntry = ServerMessageDef | ServerRequestDef

/** The two directions within a `shared` or role block. */
export interface Directional {
  /** Requests this side may call (client→server). */
  clientToServer?: Record<string, RequestDef>
  /** Events, topics, and server→client requests this side may receive. */
  serverToClient?: Record<string, ServerEntry>
}

/** A role block: its directions plus an optional `data` schema typing `conn.data`. */
export interface RoleBlock extends Directional {
  /** Schema for this role's mutable per-connection `conn.data` (server-side scratch state). */
  data?: Schema
}

/**
 * The single source of truth, imported by both server and client. Split by
 * **direction** and scoped by **role**: a `shared` base every role inherits,
 * plus one block per role. `serverToServer` is node↔node (not role-scoped).
 */
export interface Contract {
  /** Surface common to every role (merged into each role's effective surface). */
  shared?: Directional
  /** Per-role surfaces. A connection's role selects which one (plus `shared`) it sees. */
  roles: Record<string, RoleBlock>
  /** Typed node-to-node event payloads, for {@link "@super-line/server"!}'s `emitServer`/`onServer`. */
  serverToServer?: Record<string, Schema>
}

/**
 * Define a contract. An identity function — `const` preserves literal keys and
 * `subscribe: true` so the full surface can be inferred on both ends.
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 * import { defineContract } from '@super-line/core'
 *
 * export const api = defineContract({
 *   shared: {
 *     clientToServer: { join: { input: z.object({ room: z.string() }), output: z.object({ ok: z.boolean() }) } },
 *     serverToClient: { message: { payload: z.object({ text: z.string() }) } },
 *   },
 *   roles: {
 *     user:  { clientToServer: { say:      { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } } },
 *     agent: { clientToServer: { announce: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } } },
 *   },
 *   serverToServer: { rebalance: z.object({ shard: z.number() }) },
 * })
 * ```
 */
export function defineContract<const C extends Contract>(contract: C): C {
  return contract
}

/** Union of a contract's role names. */
export type RoleOf<C extends Contract> = keyof C['roles'] & string

type CtsOf<D> = D extends { clientToServer: infer M extends Record<string, RequestDef> } ? M : {}
type StcOf<D> = D extends { serverToClient: infer M extends Record<string, ServerEntry> } ? M : {}

// serverToClient split: has `input` => request; `subscribe: true` => topic; otherwise => push event.
type EventsOf<M> = {
  [K in keyof M as M[K] extends { input: Schema } ? never : M[K] extends { subscribe: true } ? never : K]: M[K]
}
type TopicsOf<M> = { [K in keyof M as M[K] extends { subscribe: true } ? K : never]: M[K] }
type ServerReqOf<M> = { [K in keyof M as M[K] extends { input: Schema } ? K : never]: M[K] }

/** A role's effective request map: `shared` ∪ `roles[R]` client→server requests. */
export type Requests<C extends Contract, R extends RoleOf<C>> = CtsOf<C['shared']> &
  CtsOf<C['roles'][R]>
/** A role's effective server→client map (events and topics combined). */
export type ServerMessages<C extends Contract, R extends RoleOf<C>> = StcOf<C['shared']> &
  StcOf<C['roles'][R]>
/** A role's push events (server→client entries without `subscribe`). */
export type Events<C extends Contract, R extends RoleOf<C>> = EventsOf<ServerMessages<C, R>>
/** A role's subscribable topics (server→client entries with `subscribe: true`). */
export type Topics<C extends Contract, R extends RoleOf<C>> = TopicsOf<ServerMessages<C, R>>

/** Requests in the `shared` block (every role can call these). */
export type SharedRequests<C extends Contract> = CtsOf<C['shared']>
/** Requests in one role's block (not including `shared`). */
export type RoleRequests<C extends Contract, R extends RoleOf<C>> = CtsOf<C['roles'][R]>
/** Push events in the `shared` block (broadcastable to a mixed-role room). */
export type SharedEvents<C extends Contract> = EventsOf<StcOf<C['shared']>>
/** Subscribable topics in the `shared` block (published via `srv.publish`). */
export type SharedTopics<C extends Contract> = TopicsOf<StcOf<C['shared']>>
/** Subscribable topics in one role's block (published via `srv.forRole(r).publish`). */
export type RoleTopics<C extends Contract, R extends RoleOf<C>> = TopicsOf<StcOf<C['roles'][R]>>

/** A role's effective server→client requests (`shared` ∪ `roles[R]`), answered by `client.implement`. */
export type ServerRequests<C extends Contract, R extends RoleOf<C>> = ServerReqOf<ServerMessages<C, R>>
/** Server→client requests in the `shared` block (the surface `srv.toConn(id).request` can call). */
export type SharedServerRequests<C extends Contract> = ServerReqOf<StcOf<C['shared']>>

/** The typed shape of `conn.data` for role `R` (its `data` schema, or an empty object). */
export type DataOf<C extends Contract, R extends RoleOf<C>> = C['roles'][R] extends {
  data: infer S extends Schema
}
  ? InferOut<S>
  : Record<string, never>
/** Union of every role's `conn.data` shape (used where the role isn't narrowed, e.g. shared handlers). */
export type AnyData<C extends Contract> = DataOf<C, RoleOf<C>>

/** The `serverToServer` map, or `{}` if the contract has none. */
export type ServerEvents<C extends Contract> = C['serverToServer'] extends Record<string, Schema>
  ? C['serverToServer']
  : {}

// Guarded extractors: re-assert the def constraint so indexed access stays a Schema.
/** The input type a client passes for a request (pre-validation). */
export type ClientInput<T> = T extends RequestDef ? InferIn<T['input']> : never
/** The input type a server handler receives for a request (post-validation). */
export type ServerInput<T> = T extends RequestDef ? InferOut<T['input']> : never
/** The reply type of a request (server returns / client receives). */
export type Output<T> = T extends RequestDef ? InferOut<T['output']> : never
/** The data a client receives for an event/topic (post-validation). */
export type EventData<T> = T extends ServerMessageDef ? InferOut<T['payload']> : never
/** The data a server sends for an event/topic (pre-validation). */
export type EmitData<T> = T extends ServerMessageDef ? InferIn<T['payload']> : never
/** The data a server sends for a serverToServer event. */
export type ServerEmit<T> = T extends Schema ? InferIn<T> : never
/** The data a server receives for a serverToServer event. */
export type ServerData<T> = T extends Schema ? InferOut<T> : never

/** Infer a schema's **input** type (what you pass into the validator). */
export type InferIn<S extends Schema> = StandardSchemaV1.InferInput<S>
/** Infer a schema's **output** type (the validated result). */
export type InferOut<S extends Schema> = StandardSchemaV1.InferOutput<S>

/**
 * Validate a value against a Standard Schema validator (sync or async).
 *
 * @param schema - the validator to run.
 * @param value - the untrusted value to validate.
 * @returns the parsed, typed value.
 * @throws {@link SocketError} with code `VALIDATION` if the value doesn't match.
 */
export async function validate<S extends Schema>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  let result = schema['~standard'].validate(value)
  if (result instanceof Promise) result = await result
  if (result.issues) {
    throw new SocketError('VALIDATION', 'Validation failed', result.issues)
  }
  return result.value
}

/**
 * Synchronous validation for hot paths (e.g. client inbound dispatch).
 *
 * @param schema - the validator to run.
 * @param value - the untrusted value to validate.
 * @returns the parsed, typed value.
 * @throws {@link SocketError} with code `VALIDATION` on mismatch, or `INTERNAL` if the schema is async.
 */
export function validateSync<S extends Schema>(
  schema: S,
  value: unknown,
): StandardSchemaV1.InferOutput<S> {
  const result = schema['~standard'].validate(value)
  if (result instanceof Promise) {
    throw new SocketError('INTERNAL', 'Async schema not supported for synchronous validation')
  }
  if (result.issues) {
    throw new SocketError('VALIDATION', 'Validation failed', result.issues)
  }
  return result.value
}
