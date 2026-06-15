import type { StandardSchemaV1 } from '@standard-schema/spec'
import { SocketError } from './errors.js'

export type Schema = StandardSchemaV1

// client -> server request (req/res). Fire-and-forget signals are deferred.
export interface RequestDef {
  input: Schema
  output: Schema
}

// server -> client message. `subscribe: true` makes it a client-subscribable
// topic; otherwise it is a server-pushed event.
export interface ServerMessageDef {
  payload: Schema
  subscribe?: boolean
}

export interface Directional {
  clientToServer?: Record<string, RequestDef>
  serverToClient?: Record<string, ServerMessageDef>
}

// One shared contract. Direction is the axis; role is the outer key with a
// `shared` base every role inherits. serverToServer is node<->node (not a role).
export interface Contract {
  shared?: Directional
  roles: Record<string, Directional>
  serverToServer?: Record<string, Schema>
}

// identity helper; `const` preserves literal keys + `subscribe: true` for inference
export function defineContract<const C extends Contract>(contract: C): C {
  return contract
}

export type RoleOf<C extends Contract> = keyof C['roles'] & string

type CtsOf<D> = D extends { clientToServer: infer M extends Record<string, RequestDef> } ? M : {}
type StcOf<D> = D extends { serverToClient: infer M extends Record<string, ServerMessageDef> }
  ? M
  : {}

// Effective surface for a role = shared ∪ roles[R] (keys assumed disjoint).
export type Requests<C extends Contract, R extends RoleOf<C>> = CtsOf<C['shared']> &
  CtsOf<C['roles'][R]>

export type ServerMessages<C extends Contract, R extends RoleOf<C>> = StcOf<C['shared']> &
  StcOf<C['roles'][R]>

// serverToClient split: no `subscribe` => push event; `subscribe: true` => topic.
export type Events<C extends Contract, R extends RoleOf<C>> = {
  [K in keyof ServerMessages<C, R> as ServerMessages<C, R>[K] extends { subscribe: true }
    ? never
    : K]: ServerMessages<C, R>[K]
}

export type Topics<C extends Contract, R extends RoleOf<C>> = {
  [K in keyof ServerMessages<C, R> as ServerMessages<C, R>[K] extends { subscribe: true }
    ? K
    : never]: ServerMessages<C, R>[K]
}

export type ServerEvents<C extends Contract> = C['serverToServer'] extends Record<string, Schema>
  ? C['serverToServer']
  : {}

export type InferIn<S extends Schema> = StandardSchemaV1.InferInput<S>
export type InferOut<S extends Schema> = StandardSchemaV1.InferOutput<S>

// Runtime validation against a Standard Schema validator. Sync or async.
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

// Synchronous validation for hot paths (e.g. client inbound dispatch). Throws on async schemas.
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
