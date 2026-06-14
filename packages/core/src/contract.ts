import type { StandardSchemaV1 } from '@standard-schema/spec'
import { SocketError } from './errors.js'

export type Schema = StandardSchemaV1

export interface MessageDef {
  input: Schema
  output: Schema
}

export interface Contract {
  messages?: Record<string, MessageDef>
  events?: Record<string, Schema>
  topics?: Record<string, Schema>
}

// identity helper; `const` preserves literal keys for inference
export function defineContract<const C extends Contract>(contract: C): C {
  return contract
}

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
