/**
 * planColumns — Zod→column introspection for typed per-collection tables
 * (PLAN-collections-typed-tables.md, Phase 0). Core owns the schema walk so the SQL
 * backends (collections-sqlite / collections-pglite) never import zod; they render
 * dialect DDL/statements from the abstract plan. A non-introspectable schema (Valibot/
 * ArkType/any non-ZodObject) degrades to the key column plus one `_sl_data` JSON column —
 * still one table per collection, still conformant.
 *
 * The plan describes the validated OUTPUT row (what `validate()` returns and backends
 * store): a `.default()`/`.catch()` field is always present post-validation, so it is not
 * `optional` here. `optional` (field may be absent) and `nullable` (field may be `null`)
 * are tracked separately because the query evaluator distinguishes missing from null —
 * backends store SQL NULL for both and use these flags to reconstruct the right one.
 */

import {
  ZodBoolean,
  ZodCatch,
  ZodDefault,
  ZodEffects,
  ZodEnum,
  ZodLiteral,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodString,
  type ZodTypeAny,
} from 'zod'
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

function unwrap(t: ZodTypeAny): { leaf: ZodTypeAny; optional: boolean; nullable: boolean } {
  if (t instanceof ZodOptional) return { ...unwrap(t.unwrap()), optional: true }
  if (t instanceof ZodNullable) return { ...unwrap(t.unwrap()), nullable: true }
  // default/catch fill absence at this layer: the validated output always carries the field,
  // erasing inner optionality; inner nullability survives (null is a value, not absence).
  if (t instanceof ZodDefault) return { ...unwrap(t.removeDefault()), optional: false }
  if (t instanceof ZodCatch) return { ...unwrap(t.removeCatch()), optional: false }
  // refine keeps the output type; transform/preprocess don't — those fall through to 'json'.
  if (t instanceof ZodEffects && t._def.effect.type === 'refinement') return unwrap(t.innerType())
  return { leaf: t, optional: false, nullable: false }
}

function kindOf(leaf: ZodTypeAny): ColumnKind {
  if (leaf instanceof ZodString || leaf instanceof ZodEnum) return 'text'
  if (leaf instanceof ZodNumber) return 'real'
  if (leaf instanceof ZodBoolean) return 'integer-bool'
  if (leaf instanceof ZodLiteral) {
    const v = leaf.value
    if (typeof v === 'string') return 'text'
    if (typeof v === 'number') return 'real'
    if (typeof v === 'boolean') return 'integer-bool'
  }
  return 'json'
}

function finish(key: string, degenerate: boolean, columns: ColumnSpec[]): ColumnPlan {
  const sorted = [...columns].sort((a, b) => (a.name < b.name ? -1 : 1))
  const fingerprint = [
    degenerate ? 'v1:degenerate' : 'v1',
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
  const schema: unknown = def.schema
  if (!(schema instanceof ZodObject)) {
    return finish(def.key, true, [
      { name: def.key, kind: 'text', optional: false, nullable: false },
      { name: DEGENERATE_DATA_COLUMN, kind: 'json', optional: false, nullable: false },
    ])
  }
  const columns: ColumnSpec[] = []
  for (const [name, field] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
    checkIdent(name)
    const { leaf, optional, nullable } = unwrap(field)
    columns.push({ name, kind: kindOf(leaf), optional, nullable })
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
