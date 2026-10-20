import * as z from 'zod'
import { defineContractPlugin } from '@super-line/core'

const value = z.union([z.string(), z.number(), z.null(), z.object({ blob: z.string() })])

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
