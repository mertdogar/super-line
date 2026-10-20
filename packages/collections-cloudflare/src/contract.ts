import * as z from 'zod'
import { defineContractPlugin } from '@super-line/core'

const value = z.union([z.string(), z.number(), z.null(), z.object({ blob: z.string() })])

// `syncedSql`'s query wire, here so a browser calling a source's `query` imports no Workers types.
/** A cell on the wire: SQLite's own types, with a blob as base64 under `blob`. */
export type Value = string | number | null | { blob: string }
export type Statement = { sql: string; params?: Value[] }
export type Result = {
  columns: string[]
  rows: Value[][]
  meta: { rowsRead: number; rowsWritten: number }
}
/** `bytes` is set when the batch's rows passed `maxBytes`; the message then names the cap. */
export type Outcome = { results: Result[] } | { error: string; statement: number; bytes?: number }
/**
 * `readOnly` rolls the batch back as soon as a statement writes a row or changes the schema; `maxBytes` rolls it
 * back as soon as the serialized rows of the batch pass the cap.
 */
export type QueryOptions = { readOnly?: boolean; maxBytes?: number }

/** One row of a source's table, as the node serves it. `key` is `${storeId}:${table}:${id}`. */
export const remoteRowSchema = z.object({
  key: z.string(),
  storeId: z.string(),
  table: z.string(),
  id: z.string(),
  data: z.record(z.string(), value),
})
export type RemoteRowsRow = z.infer<typeof remoteRowSchema>

type RemoteRowsFragment<N extends string> = { collections: { [K in N]: { schema: typeof remoteRowSchema; key: 'key' } } }

/**
 * The contract half of `remoteRows`: one read-only collection `name` holding the rows of every source the node
 * fronts, keyed `${storeId}:${table}:${id}`, with each row's columns opaque under `data`. Its own subpath, so a
 * contract package doesn't pull in the Durable Object side.
 *
 * ```ts
 * defineContract({ roles, plugins: [remoteRowsCollection('storeRows')] })
 * ```
 */
export function remoteRowsCollection<const N extends string>(name: N) {
  const fragment = { collections: { [name]: { schema: remoteRowSchema, key: 'key' } } } as RemoteRowsFragment<N>
  return defineContractPlugin(`remote-rows:${name}`, fragment)
}
