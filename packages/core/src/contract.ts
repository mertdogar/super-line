import type { StandardSchemaV1 } from '@standard-schema/spec'
import { SuperLineError } from './errors.js'

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

/** A role block: its directions plus optional `data`/`env` schemas typing `conn.data`/`conn.env`. */
export interface RoleBlock extends Directional {
  /** Schema for this role's mutable per-connection `conn.data` (server-side scratch state). */
  data?: Schema
  /** Schema for this role's server-vended, CLIENT-VISIBLE per-connection `conn.env` (ADR-0012). */
  env?: Schema
}

/**
 * Per-document super-store config for a CRDT collection (ADR-0007). `mode: 'document'` makes the doc a
 * recursive CRDT (nested-field merge); `opaque` keeps named subtrees atomic (discriminated-union blobs).
 * Lives on the contract so both halves derive it from one source — the drift-free replacement for
 * store-sync's "supply the SAME resolver to both halves" footgun.
 */
export interface DocOptions {
  mode?: 'shallow' | 'document'
  opaque?: string[]
}

/**
 * A typed row collection (the relational store family; see ADR-0006). Rows are validated against
 * `schema` on every write — end-to-end types + validate-every-message for row data.
 */
export interface LwwCollectionDef {
  /** Row schema — any Standard Schema (Zod/Valibot/ArkType). The server validates every row write against it. */
  schema: Schema
  /**
   * The primary-key field: `row[key]` becomes the resource id, so it must be a present string field.
   * Kept as a plain `string` (not `keyof row`) to avoid perturbing `defineContract`'s inference — the
   * server validates its presence/type at write time. // ponytail: tighten to `keyof InferOut<schema>` later if the inference cost is worth it.
   */
  key: string
  /**
   * Advisory foreign keys — `{ authorId: 'users' }` maps a field to a referenced collection name.
   * Metadata only: feeds the Control Center schema graph and TanStack adapter join hints, plus an
   * opt-in existence check on write. No cascades in core (unsound under masterless relay clustering).
   */
  references?: Record<string, string>
}

/**
 * A CRDT document collection (ADR-0007). Opened by id (whole-doc merge, not queryable); the presence of the
 * `crdt` key discriminates it from an {@link LwwCollectionDef}. No `key` — the doc id is external (passed to
 * `open(id)`), not extracted from the doc body. `schema` types the doc end-to-end AND is the ingress
 * validation gate (validate-before-commit against the post-merge plaintext snapshot).
 */
export interface CrdtCollectionDef {
  /** Doc schema — any Standard Schema. Types `open(id)` and gates every write at ingress. */
  schema: Schema
  /** Marks the collection CRDT; carries the super-store {@link DocOptions}. */
  crdt: DocOptions
}

/** A collection is either a typed LWW row table (ADR-0006) or a CRDT document store (ADR-0007). */
export type CollectionDef = LwwCollectionDef | CrdtCollectionDef

/** Runtime + type guard: a CRDT document collection (has a `crdt` key) vs an LWW row collection. */
export function isCrdtCollection(def: CollectionDef): def is CrdtCollectionDef {
  return 'crdt' in def
}

/**
 * The single source of truth, imported by both server and client. Split by
 * **direction** and scoped by **role**: a `shared` base every role inherits,
 * plus one block per role.
 */
export interface Contract {
  /** Surface common to every role (merged into each role's effective surface). */
  shared?: Directional
  /** Per-role surfaces. A connection's role selects which one (plus `shared`) it sees. */
  roles: Record<string, RoleBlock>
  /**
   * Typed row collections (see {@link CollectionDef}). A top-level sibling of `roles`, not a role
   * block: a collection is a global data domain, and per-caller visibility is a server-side row policy,
   * not contract structure.
   */
  collections?: Record<string, CollectionDef>
  /**
   * The {@link ContractPlugin}s whose fragments were merged in (ADR-0016). An INPUT to `defineContract`,
   * retained on the merged result so the origin of each collection/surface key stays knowable — the
   * Control Center attributes contract entries to their owning plugin from this. Contract-time only:
   * a plugin may contribute runtime behavior without a fragment (the inspector), so this is NOT the
   * list of plugins registered on the server.
   */
  plugins?: readonly ContractPlugin[]
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
 * })
 * ```
 */
export function defineContract<const C extends Contract & { plugins: readonly ContractPlugin[] }>(
  contract: C,
): ResolveContract<C>
export function defineContract<const C extends Contract>(contract: C): C
export function defineContract(contract: ContractWithPlugins): Contract {
  const pluginList = contract.plugins
  if (!pluginList || pluginList.length === 0) return contract
  const collections: Record<string, CollectionDef> = { ...contract.collections }
  const roles: Record<string, RoleBlock> = {}
  for (const [name, block] of Object.entries(contract.roles)) roles[name] = { ...block }
  let shared = contract.shared
  for (const plugin of pluginList) {
    const { fragment } = plugin
    for (const [name, def] of Object.entries(fragment.collections ?? {})) {
      if (name in collections) {
        throw new Error(`defineContract: plugin '${plugin.name}' collection '${name}' collides with an existing collection`)
      }
      collections[name] = def
    }
    if (fragment.shared) shared = mergeDirectional(shared, fragment.shared, `plugin '${plugin.name}' shared`)
    for (const [name, block] of Object.entries(fragment.roles ?? {})) {
      const current = roles[name]
      roles[name] = current ? mergeRoleBlock(current, block, `plugin '${plugin.name}' role '${name}'`) : { ...block }
    }
  }
  return { ...(shared ? { shared } : {}), roles, collections, plugins: pluginList }
}

/** Union of a contract's role names. */
export type RoleOf<C extends Contract> = keyof C['roles'] & string

/** The `clientToServer` request map of a {@link Directional}/surface (`{}` if none). Public so plugins can key handlers off a paired surface's requests. */
export type CtsOf<D> = D extends { clientToServer: infer M extends Record<string, RequestDef> } ? M : {}
type StcOf<D> = D extends { serverToClient: infer M extends Record<string, ServerEntry> } ? M : {}

// ── Surface composition (embedding one super-line surface into another app's contract) ──

// flatten an intersection for readable hovers
type Flat<T> = { [K in keyof T]: T[K] }
// keys present in both maps; skips the check when either side is too wide to know (Record<string, …>)
type DupKeys<X, Y> = string extends keyof X ? never : string extends keyof Y ? never : Extract<keyof X, keyof Y> & string
type SurfaceOverlap<A extends Directional, B extends Directional> =
  | DupKeys<CtsOf<A>, CtsOf<B>>
  | DupKeys<StcOf<A>, StcOf<B>>
// collision => the parameter demands a property the argument can't have, and the error names the keys
type NoOverlap<A extends Directional, B extends Directional> = [SurfaceOverlap<A, B>] extends [never]
  ? unknown
  : { 'mergeSurfaces: duplicate keys': SurfaceOverlap<A, B> }

type MergedSurface<A extends Directional, B extends Directional> = Flat<{
  clientToServer: Flat<CtsOf<A> & CtsOf<B>>
  serverToClient: Flat<StcOf<A> & StcOf<B>>
}>

/**
 * Define an exportable contract fragment (a {@link Directional}) outside `defineContract`.
 * An identity function whose `const` type parameter preserves literal keys and
 * `subscribe: true` — a fragment declared as a plain `const` widens `subscribe` to
 * `boolean`, silently degrading topics to push events once merged.
 *
 * @example
 * ```ts
 * // a library exports its surface with prefixed keys…
 * export const harnessSurface = defineSurface({
 *   clientToServer: { 'harness.join': { input: z.object({ threadId: z.string() }), output: z.object({ ok: z.boolean() }) } },
 *   serverToClient: { 'harness.suspended': { payload: suspendedSchema } },
 * })
 * ```
 */
export function defineSurface<const D extends Directional>(surface: D): D {
  return surface
}

/**
 * Merge two surfaces into one, per direction. A duplicate key is a **compile error
 * naming the key** (and a runtime throw for untyped callers) — rename or prefix
 * (e.g. `'harness.join'`) instead of letting a spread silently clobber.
 *
 * @example
 * ```ts
 * // …and the host app mounts it into one of its roles:
 * const contract = defineContract({
 *   roles: { user: mergeSurfaces(harnessSurface, defineSurface({ clientToServer: { say: … } })) },
 * })
 * ```
 */
export function mergeSurfaces<
  const A extends Directional & { data?: never; env?: never },
  const B extends Directional & { data?: never; env?: never },
>(a: A, b: B & NoOverlap<A, B>): MergedSurface<A, B> {
  for (const s of [a, b] as Directional[]) {
    for (const k of Object.keys(s)) {
      if (k !== 'clientToServer' && k !== 'serverToClient') {
        throw new Error(
          `mergeSurfaces: unexpected key '${k}' — pass only { clientToServer, serverToClient } (a role's 'data'/'env' belongs on the role block, outside the merge)`,
        )
      }
    }
  }
  const dups = [
    ...Object.keys(a.clientToServer ?? {}).filter((k) => k in (b.clientToServer ?? {})),
    ...Object.keys(a.serverToClient ?? {}).filter((k) => k in (b.serverToClient ?? {})),
  ]
  if (dups.length > 0) {
    throw new Error(`mergeSurfaces: duplicate keys: ${dups.join(', ')} — rename or prefix (e.g. 'harness.join')`)
  }
  return {
    clientToServer: { ...a.clientToServer, ...b.clientToServer },
    serverToClient: { ...a.serverToClient, ...b.serverToClient },
  } as MergedSurface<A, B>
}

// ── contract plugins (contract-time fragment composition) ──
// ADR-0005's paired runtime bundle grows a contract-time half: a plugin can contribute collections,
// roles, and shared surface that `defineContract` merges INTO the contract, so end-to-end types
// (`RowOf`, per-role `Requests`, `client.collection`) flow from the single materialized contract object
// exactly as hand-declared surface does. The plugin's server/client runtime halves register separately.

/** A contract fragment a plugin contributes at {@link defineContract} time: any subset of a contract's typed surface. */
export interface ContractFragment {
  shared?: Directional
  roles?: Record<string, RoleBlock>
  collections?: Record<string, CollectionDef>
}

/**
 * A named contract fragment — the contract-time half of a paired plugin. Pass it in
 * `defineContract({ plugins: [...] })`; its collections/roles/shared surface merge into the contract
 * (a duplicate collection name or surface key is a startup throw). Its server/client runtime halves
 * register separately on `createSuperLineServer` / `createSuperLineClient`.
 */
export interface ContractPlugin<F extends ContractFragment = ContractFragment> {
  readonly name: string
  readonly fragment: F
}

/**
 * Author a {@link ContractPlugin}. `const F` preserves literal keys and `subscribe: true` — a fragment
 * declared as a plain const widens `subscribe` to `boolean`, degrading topics to push events once merged.
 */
export function defineContractPlugin<const F extends ContractFragment>(name: string, fragment: F): ContractPlugin<F> {
  return { name, fragment }
}

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never
type ContractWithPlugins = Contract & { plugins?: readonly ContractPlugin[] }
type PluginsOf<C> = C extends { plugins: infer P extends readonly ContractPlugin[] } ? P : readonly []
type FragmentsOf<P extends readonly ContractPlugin[]> = P extends readonly []
  ? unknown
  : UnionToIntersection<P[number]['fragment']>
/**
 * The contract type after merging all plugin fragments: the base intersected with every fragment. `plugins`
 * is KEPT (ADR-0016) — the merged contract carries the fragments that formed it, so provenance survives.
 */
export type ResolveContract<C extends ContractWithPlugins> = Flat<C & FragmentsOf<PluginsOf<C>>>

function mergeDirectional(a: Directional | undefined, b: Directional, where: string): Directional {
  const out: Directional = { clientToServer: { ...a?.clientToServer }, serverToClient: { ...a?.serverToClient } }
  for (const dir of ['clientToServer', 'serverToClient'] as const) {
    const src = b[dir]
    if (!src) continue
    const dst = out[dir] as Record<string, unknown>
    for (const k of Object.keys(src)) {
      if (k in dst) throw new Error(`defineContract: ${where} duplicate ${dir} key '${k}' — rename or prefix`)
      dst[k] = (src as Record<string, unknown>)[k]
    }
  }
  return out
}

function mergeRoleBlock(a: RoleBlock, b: RoleBlock, where: string): RoleBlock {
  const merged = mergeDirectional(a, b, where) as RoleBlock
  const data = a.data ?? b.data
  const env = a.env ?? b.env
  if (data) merged.data = data
  if (env) merged.env = env
  return merged
}

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

/** The typed shape of `conn.env` for role `R` (its `env` schema, or `null` when the role declares none). */
export type EnvOf<C extends Contract, R extends RoleOf<C>> = C['roles'][R] extends {
  env: infer S extends Schema
}
  ? InferOut<S>
  : null
/** Union of every role's `conn.env` shape (used where the role isn't narrowed). */
export type AnyEnv<C extends Contract> = { [R in RoleOf<C>]: EnvOf<C, R> }[RoleOf<C>]

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

// ── collections ──

/** A contract's collection map (`{}` if it declares none). */
export type CollectionsOf<C extends Contract> = C extends {
  collections: infer M extends Record<string, CollectionDef>
}
  ? M
  : {}
/** Union of a contract's collection names (both families). */
export type CollectionName<C extends Contract> = keyof CollectionsOf<C> & string
/** Names of a contract's CRDT document collections (those declared with a `crdt` key). */
export type CrdtCollectionName<C extends Contract> = {
  [N in CollectionName<C>]: CollectionsOf<C>[N] extends CrdtCollectionDef ? N : never
}[CollectionName<C>]
/** Names of a contract's LWW row collections (everything that isn't CRDT). */
export type LwwCollectionName<C extends Contract> = Exclude<CollectionName<C>, CrdtCollectionName<C>>
/** The validated row/doc type of a collection def (what handlers and clients read). */
export type CollectionRow<D> = D extends CollectionDef ? InferOut<D['schema']> : never
/** The validated document type of CRDT collection `N` in contract `C` (alias of {@link RowOf} — the doc is the value). */
export type DocOf<C extends Contract, N extends CollectionName<C>> = CollectionRow<CollectionsOf<C>[N]>
/** The input row type of a collection def (what a client passes to insert, pre-validation). */
export type CollectionRowInput<D> = D extends CollectionDef ? InferIn<D['schema']> : never
/** The validated row type of collection `N` in contract `C`. */
export type RowOf<C extends Contract, N extends CollectionName<C>> = CollectionRow<CollectionsOf<C>[N]>
/** The input row type of collection `N` in contract `C` (pre-validation). */
export type RowInputOf<C extends Contract, N extends CollectionName<C>> = CollectionRowInput<CollectionsOf<C>[N]>

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
 * @throws {@link SuperLineError} with code `VALIDATION` if the value doesn't match.
 */
export async function validate<S extends Schema>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  let result = schema['~standard'].validate(value)
  if (result instanceof Promise) result = await result
  if (result.issues) {
    throw new SuperLineError('VALIDATION', 'Validation failed', result.issues)
  }
  return result.value
}

/**
 * Synchronous validation for hot paths (e.g. client inbound dispatch).
 *
 * @param schema - the validator to run.
 * @param value - the untrusted value to validate.
 * @returns the parsed, typed value.
 * @throws {@link SuperLineError} with code `VALIDATION` on mismatch, or `INTERNAL` if the schema is async.
 */
export function validateSync<S extends Schema>(
  schema: S,
  value: unknown,
): StandardSchemaV1.InferOutput<S> {
  const result = schema['~standard'].validate(value)
  if (result instanceof Promise) {
    throw new SuperLineError('INTERNAL', 'Async schema not supported for synchronous validation')
  }
  if (result.issues) {
    throw new SuperLineError('VALIDATION', 'Validation failed', result.issues)
  }
  return result.value
}
