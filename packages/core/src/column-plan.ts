/**
 * planColumns — schema→column introspection for typed per-collection tables.
 * Core owns the schema walk so the SQL
 * backends (collections-sqlite / collections-pglite) never import a schema library; they
 * render dialect DDL/statements from the abstract plan.
 *
 * The walk reads **Standard JSON Schema** (`~standard.jsonSchema`, the companion spec to
 * Standard Schema), never a vendor's classes — so core depends on no schema library at all
 * and zod / ArkType / Valibot / VineJS / Sury all plan identically. A schema whose library
 * hasn't implemented the companion spec degrades to the key column plus one `_sl_data` JSON
 * column — still one table per collection, still conformant.
 *
 * The plan describes the validated OUTPUT row (what `validate()` returns and backends
 * store), which is why the walk asks for `.output()`: a `.default()`/`.catch()` field is
 * always present post-validation, and the converter reports it as required. `optional`
 * (field may be absent) and `nullable` (field may be `null`) are tracked separately because
 * the query evaluator distinguishes missing from null — backends store SQL NULL for both
 * and use these flags to reconstruct the right one.
 */

import { jsonSchemaOf } from './contract.js'
import type { LwwCollectionDef } from './contract.js'

/** Storage class of a planned column; backends map it to their dialect's type. */
export type ColumnKind = 'text' | 'real' | 'integer-bool' | 'json'

/** One schema-derived column. Infra columns (`_sl_*`) are backend-owned and never appear here. */
export interface ColumnSpec {
  name: string
  kind: ColumnKind
  /** Field may be absent from the validated row. SQL NULL reads back as an omitted field. */
  optional: boolean
  /** Field may be `null`. SQL NULL reads back as `null` (wins over `optional`). */
  nullable: boolean
}

/** The abstract table layout for one collection, plus its identity for drift detection. */
export interface ColumnPlan {
  key: string
  /** Non-introspectable schema: just the key column + one {@link DEGENERATE_DATA_COLUMN} JSON column. */
  degenerate: boolean
  /** Schema declaration order (deterministic DDL); the fingerprint is order-insensitive. */
  columns: ColumnSpec[]
  /** Stable layout identity — backends persist it and refuse to boot on a non-additive diff. */
  fingerprint: string
}

/** JSON column holding the whole row when the schema can't be introspected (degenerate plans). */
export const DEGENERATE_DATA_COLUMN = '_sl_data'

const COLUMN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
// Postgres silently truncates identifiers at 63 bytes — refuse before truncation can collide.
const MAX_IDENT = 60

function checkIdent(name: string): void {
  if (name.startsWith('_sl_')) {
    throw new Error(`planColumns: field '${name}' uses the reserved '_sl_' prefix`)
  }
  if (!COLUMN_IDENT.test(name) || name.length > MAX_IDENT) {
    throw new Error(
      `planColumns: field '${name}' is not usable as a column name (letters/digits/_ starting with a letter or _, max ${MAX_IDENT} chars)`,
    )
  }
}

/** The slice of a JSON Schema node the planner reads. */
type Node = Record<string, unknown>

/** Flatten anyOf/oneOf so `string | null` reads the same however a vendor spells it. */
function branches(node: Node): Node[] {
  const union = (node.anyOf ?? node.oneOf) as Node[] | undefined
  return Array.isArray(union) ? union.flatMap(branches) : [node]
}

/** Every JSON type keyword a node admits — `type`, `type[]`, `const` and `enum` all normalise here. */
function typesOf(node: Node): Set<string> {
  const out = new Set<string>()
  for (const b of branches(node)) {
    const t = b.type
    if (typeof t === 'string') {
      out.add(t)
    } else if (Array.isArray(t)) {
      for (const x of t) out.add(String(x))
    } else if ('const' in b) {
      out.add(b.const === null ? 'null' : typeof b.const)
    } else if (Array.isArray(b.enum)) {
      for (const v of b.enum) out.add(v === null ? 'null' : typeof v)
    }
  }
  return out
}

function kindOf(node: Node): ColumnKind {
  const types = typesOf(node)
  // nullability is a separate flag, not a storage class
  types.delete('null')
  // a real union (or a node with no type at all — `{}` from an unrepresentable field) can't be one scalar column
  if (types.size !== 1) return 'json'
  const [only] = types
  if (only === 'string') return 'text'
  if (only === 'number' || only === 'integer') return 'real'
  if (only === 'boolean') return 'integer-bool'
  return 'json'
}

function finish(key: string, degenerate: boolean, columns: ColumnSpec[]): ColumnPlan {
  const sorted = [...columns].sort((a, b) => (a.name < b.name ? -1 : 1))
  const fingerprint = [
    degenerate ? 'v2:degenerate' : 'v2',
    `key=${key}`,
    ...sorted.map((c) => `${c.name}:${c.kind}${c.optional ? ':o' : ''}${c.nullable ? ':n' : ''}`),
  ].join(';')
  return { key, degenerate, columns, fingerprint }
}

/** Derive the typed-table {@link ColumnPlan} for an LWW collection def. Throws on layouts that can't work. */
export function planColumns(def: LwwCollectionDef): ColumnPlan {
  if ('crdt' in def) {
    throw new Error('planColumns: CRDT collections have no column plan (opened by id, not queried)')
  }
  checkIdent(def.key)
  const js = jsonSchemaOf(def.schema)
  const properties = js?.type === 'object' ? (js.properties as Record<string, Node> | undefined) : undefined
  if (!properties) {
    return finish(def.key, true, [
      { name: def.key, kind: 'text', optional: false, nullable: false },
      { name: DEGENERATE_DATA_COLUMN, kind: 'json', optional: false, nullable: false },
    ])
  }
  const required = new Set((js?.required as string[] | undefined) ?? [])
  const columns: ColumnSpec[] = []
  for (const [name, node] of Object.entries(properties)) {
    checkIdent(name)
    const optional = !required.has(name)
    const nullable = typesOf(node).has('null')
    // A scalar column stores both "absent" and "null" as SQL NULL — fine when only one is possible,
    // ambiguous when a field is optional AND nullable. Demote those to json: absent ⇒ SQL NULL,
    // null ⇒ the JSON text 'null', so the evaluator's missing ≠ null distinction survives storage.
    const kind = optional && nullable ? 'json' : kindOf(node)
    columns.push({ name, kind, optional, nullable })
  }
  const key = columns.find((c) => c.name === def.key)
  if (!key) throw new Error(`planColumns: key '${def.key}' is not a field of the schema`)
  if (key.kind !== 'text') {
    throw new Error(`planColumns: key '${def.key}' must be a string field (got ${key.kind})`)
  }
  if (key.optional || key.nullable) {
    throw new Error(`planColumns: key '${def.key}' must be required and non-nullable`)
  }
  return finish(def.key, false, columns)
}
