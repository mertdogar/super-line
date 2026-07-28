import { createHash, timingSafeEqual } from 'node:crypto'
import { getLogger } from '@logtape/logtape'
import {
  SuperLineError,
  INSPECTOR_ROLE,
  INSPECTOR_SUBPROTOCOL,
  InspectorContract,
  classifyContract,
  eventPayload,
  isCrdtCollection,
  withRowMeta,
  matchesFilter,
  andFilters,
  safeSnapshot as snapshotValue,
  ROW_CREATED_AT,
  ROW_UPDATED_AT,
  type Contract,
  type Directional,
  type Handshake,
  type Schema,
  type Expr,
  type DocListOpts,
  type InspectorEvent,
  type InspectorEnvelope,
  type InspectedContract,
  type InspectedContribution,
  type InspectedPlugin,
  type ConnView,
  type NodeView,
  type CollectionInfo,
  type CollectionQuery,
} from '@super-line/core'
import type { SuperLinePlugin, PluginChannel, ServerCrdtCollectionHandle } from '@super-line/server'

/** Options for {@link inspector}. */
export interface InspectorOptions {
  /** Field names to mask (`[Redacted]`) in snapshotted payloads / ctx / data. */
  redact?: string[]
  /**
   * `env` keys to reveal in clear in the Control Center (ADR-0012). `env` holds credentials, so it is
   * MASKED BY DEFAULT (values → `•••`, shape always shown); list the non-secret keys (e.g. `['projectId']`)
   * to show their values. The opposite default from `redact` (a deny-list) and from ctx/data (shown).
   */
  revealEnvKeys?: string[]
  /**
   * Who may open the Control Center channel (ADR-0022). A literal `{ username, password }` is compared
   * timing-safely against the `user` / `password` handshake params the Control Center sends; a function is
   * called with the raw {@link Handshake} and rejects by throwing (its message reaches the client as the
   * close reason) — that form is the seam for gating on a host's own identity system, e.g. verifying a
   * `@super-line/plugin-auth` assertion, without this package depending on it.
   *
   * Omitted, the env vars `SUPER_LINE_INSPECTOR_PASSWORD` (+ optional `SUPER_LINE_INSPECTOR_USER`,
   * default `admin`) are consulted. With neither, the channel stays **open to anyone who can reach the
   * port** — the pre-ADR-0022 behaviour — and logs a warning on `['super-line','plugin-inspector','auth']`.
   */
  auth?: InspectorAuth
}

/** What {@link InspectorOptions.auth} accepts: a fixed credential, or a predicate over the handshake. */
export type InspectorAuth = { username?: string; password: string } | ((handshake: Handshake) => unknown | Promise<unknown>)

const encoder = new TextEncoder()
function encodedByteSize(encoded: string | Uint8Array): number {
  return typeof encoded === 'string' ? encoder.encode(encoded).length : encoded.byteLength
}

const logAuth = getLogger(['super-line', 'plugin-inspector', 'auth'])

// Compare via SHA-256 digests rather than the raw strings: the digests are always the same length, so there is
// no length check to return early on — which a direct timingSafeEqual would need, leaking the secret's length.
const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b))

/**
 * The effective admission check for the Control Center channel (ADR-0022): the explicit `auth` option, else the
 * env vars, else `undefined` — which leaves the channel open, exactly as before ADR-0022.
 */
function resolveAuth(auth: InspectorAuth | undefined): ((handshake: Handshake) => unknown) | undefined {
  if (typeof auth === 'function') return auth
  const username = auth?.username ?? process.env.SUPER_LINE_INSPECTOR_USER ?? 'admin'
  const password = auth?.password ?? process.env.SUPER_LINE_INSPECTOR_PASSWORD
  if (!password) return undefined
  return (handshake) => {
    // Both compares always run — `&&` would skip the password check on a wrong username, timing which half failed.
    const okUser = safeEqual(handshake.query.user ?? '', username)
    const okPassword = safeEqual(handshake.query.password ?? '', password)
    if (!okUser || !okPassword) throw new SuperLineError('UNAUTHORIZED', 'invalid inspector credentials')
    return { username }
  }
}

// Best-effort schema → JSON Schema, via lazy, optional @standard-community/standard-json. The package (and
// per-vendor converter) is optional — a missing/unsupported converter falls back to structure-only.
async function loadJsonConverter(): Promise<((s: Schema) => Promise<unknown>) | null> {
  try {
    const mod = await import('@standard-community/standard-json')
    return mod.toJsonSchema as unknown as (s: Schema) => Promise<unknown>
  } catch {
    return null
  }
}

// The plugins this server is composed of (ADR-0016): the contract-time half (each merged fragment's keys,
// read straight off the retained `contract.plugins`) joined by name with the runtime half (`ctx.plugins`).
// A plugin present in only one half is reported as such — that asymmetry is the diagnostic.
function buildInspectedPlugins(contract: Contract, runtime: readonly string[]): InspectedPlugin[] {
  const keysOf = (d: Directional | undefined): InspectedContribution => ({
    clientToServer: Object.keys(d?.clientToServer ?? {}),
    serverToClient: Object.keys(d?.serverToClient ?? {}),
  })
  const out: InspectedPlugin[] = []
  const seen = new Set<string>()
  for (const { name, fragment } of contract.plugins ?? []) {
    seen.add(name)
    const roles = Object.fromEntries(Object.entries(fragment.roles ?? {}).map(([r, b]) => [r, keysOf(b)]))
    out.push({
      name,
      runtime: runtime.includes(name),
      contract: {
        collections: Object.keys(fragment.collections ?? {}),
        ...(fragment.shared ? { shared: keysOf(fragment.shared) } : {}),
        ...(Object.keys(roles).length > 0 ? { roles } : {}),
      },
    })
  }
  for (const name of runtime) if (!seen.has(name)) out.push({ name, runtime: true }) // runtime-only (e.g. the inspector)
  return out
}

// getContract structure + best-effort JSON Schema for each message.
async function buildInspectedContract(contract: Contract): Promise<InspectedContract> {
  const toJsonSchema = await loadJsonConverter()
  if (!toJsonSchema) return classifyContract(contract) // converter unavailable -> structure only
  const schemas = new Set<Schema>()
  classifyContract(contract, (s) => {
    schemas.add(s)
    return undefined
  })
  const converted = new Map<Schema, unknown>()
  await Promise.all(
    [...schemas].map((s) =>
      toJsonSchema(s).then(
        (j) => {
          converted.set(s, j)
        },
        () => {}, // unsupported vendor / missing per-vendor converter -> structure-only for this entry
      ),
    ),
  )
  return classifyContract(contract, (s) => converted.get(s))
}

// listCollections: structural info (name/key/references) + best-effort JSON Schema of each row for the graph.
async function buildCollectionInfos(
  contract: Contract,
  infos: { name: string; key: string; references: Record<string, string> }[],
): Promise<CollectionInfo[]> {
  const toJsonSchema = await loadJsonConverter()
  const defs = contract.collections ?? {}
  return Promise.all(
    infos.map(async (info) => {
      const def = defs[info.name]
      const schema = def?.schema
      let json: unknown
      if (toJsonSchema && schema) {
        try {
          json = await toJsonSchema(schema) // may throw sync (no per-vendor converter) or reject — either way, structure-only
        } catch {
          json = undefined
        }
      }
      const crdt = def ? isCrdtCollection(def) : false
      return { ...info, crdt, ...(json !== undefined ? { schema: json } : {}) } satisfies CollectionInfo
    }),
  )
}

// CRDT docs aren't content-queryable — the only filter they support is an id substring. Pull it out of an
// `id` eq/like/ilike predicate (the shape the Control Center's CRDT filter builds), recursing through `and`.
function idContainsOf(filter: Expr | undefined): string | undefined {
  if (!filter) return undefined
  if ((filter.op === 'like' || filter.op === 'ilike') && filter.field === 'id') return filter.pattern.replace(/%/g, '')
  if (filter.op === 'eq' && filter.field === 'id' && typeof filter.value === 'string') return filter.value
  if (filter.op === 'and') for (const a of filter.args) {
    const r = idContainsOf(a)
    if (r) return r
  }
  return undefined
}

// Map a Control Center orderBy field to the CRDT store's sortable dimensions (id / created / updated).
function crdtSortBy(field: string | undefined): 'id' | 'createdAt' | 'updatedAt' | undefined {
  if (field === 'id') return 'id'
  if (field === ROW_CREATED_AT) return 'createdAt'
  if (field === ROW_UPDATED_AT) return 'updatedAt'
  return undefined
}

const isTsField = (field: string): boolean => field === ROW_CREATED_AT || field === ROW_UPDATED_AT

// Does the filter reference a reserved created/updated key? Such predicates can't push down (the timestamps
// live outside the row data), so the row branch scans + merges rowMeta + evaluates the full filter in JS.
function filterMentionsTs(expr: Expr | undefined): boolean {
  if (!expr) return false
  if ('args' in expr) return expr.args.some(filterMentionsTs) // and | or
  if ('arg' in expr) return filterMentionsTs(expr.arg) // not
  return isTsField(expr.field)
}

// The pushable subset of a filter: drop any timestamp predicate (the backend would json_extract a missing
// field → wrongly exclude). Only narrows the scan; `matchesFilter` re-checks the full filter after the merge.
function stripTs(expr: Expr | undefined): Expr | undefined {
  if (!expr) return undefined
  if ('args' in expr) return expr.op === 'and' ? andFilters(...expr.args.map(stripTs)) : filterMentionsTs(expr) ? undefined : expr // or: can't split → don't push
  if ('arg' in expr) return filterMentionsTs(expr) ? undefined : expr // not
  return isTsField(expr.field) ? undefined : expr
}

/**
 * The Control Center inspector, packaged as a plugin. It taps every request/event, snapshots +
 * field-redacts the payloads, and publishes them (cluster-wide) on its own plugin channel; and it declares a
 * plugin-owned, observer-invisible connection class (the `superline.inspector.v1` subprotocol) that serves
 * Control Center clients the `InspectorContract` — `getContract`, `getTopology`, `getConn`, … and the
 * `events` feed. Register it with `plugins: [inspector()]`. **Dev / trusted-network only.**
 */
export function inspector(opts: InspectorOptions = {}): SuperLinePlugin {
  const redact = new Set(opts.redact ?? [])
  const revealEnvKeys = new Set(opts.revealEnvKeys ?? [])
  const authenticate = resolveAuth(opts.auth)

  // env is masked-by-default (ADR-0012): show the shape (all keys), but mask each value to `•••` unless the
  // key is allow-listed via `revealEnvKeys` — the opposite of `redact`. Revealed values still pass through
  // safeSnapshot (so `redact` and depth/size caps still apply within them).
  function maskEnv(value: unknown): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value === null ? null : '•••'
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as object)) out[k] = revealEnvKeys.has(k) ? safeSnapshot(v) : '•••'
    return out
  }

  // best-effort, never-throwing snapshot of a value for display (node-local); masks redacted field names
  const safeSnapshot = (value: unknown): unknown => snapshotValue(value, redact)

  // Replace an event's payload field(s) with a redacted safe snapshot — the display-only copy put on the wire.
  function snapshotEvent(event: InspectorEvent): InspectorEvent {
    switch (event.type) {
      case 'msg.request':
      case 'msg.serverRequest':
        return { ...event, input: safeSnapshot(event.input) }
      case 'msg.response':
      case 'msg.serverReply':
        return event.ok ? { ...event, output: safeSnapshot(event.output) } : event
      case 'msg.event':
      case 'msg.broadcast':
      case 'msg.publish':
        return { ...event, data: safeSnapshot(event.data) }
      case 'collection.sub':
        return { ...event, query: safeSnapshot(event.query) }
      case 'collection.write':
        return { ...event, ops: safeSnapshot(event.ops) }
      case 'collection.change':
        return { ...event, row: safeSnapshot(event.row) }
      case 'crdt.open':
      case 'crdt.write':
        return event.ok ? { ...event, snapshot: safeSnapshot(event.snapshot) } : event
      case 'env.set':
        return { ...event, env: maskEnv(event.env) }
      default:
        return event
    }
  }

  // captured in setup(), used by the tap (which doesn't receive the context)
  let channel: PluginChannel | undefined
  let originNodeId = ''
  let encode: (value: unknown) => string | Uint8Array = (v) => JSON.stringify(v)

  return {
    name: 'inspector',
    setup(ctx) {
      channel = ctx.channel('events') // the CC's `events` feed rides this plugin channel (cluster-wide)
      originNodeId = ctx.instanceId
      encode = (v) => ctx.serializer.encode(v)
      if (!authenticate)
        logAuth.warning(
          'the inspector channel is UNAUTHENTICATED — anyone who can reach this port can read every ' +
            'collection (row policies are bypassed), every connection ctx, and the live message feed. Set ' +
            'SUPER_LINE_INSPECTOR_PASSWORD, or pass inspector({ auth }).',
        )
    },
    onEvent(event) {
      if (!channel) return
      const snapped = snapshotEvent(event)
      const payload = eventPayload(snapped)
      const envelope: InspectorEnvelope = {
        event: snapped,
        ts: Date.now(),
        originNodeId,
        byteSize: payload === undefined ? undefined : encodedByteSize(encode(payload)),
      }
      channel.publish(envelope)
    },
    connection: {
      role: INSPECTOR_ROLE,
      subprotocol: INSPECTOR_SUBPROTOCOL,
      ...(authenticate ? { authenticate } : {}),
      contract: InspectorContract,
      handlers: (ctx) => ({
        getContract: async () => ({
          ...(await buildInspectedContract(ctx.contract)),
          plugins: buildInspectedPlugins(ctx.contract, ctx.plugins),
        }),
        getTopology: () => ctx.cluster.topology(),
        listConnections: () => ctx.cluster.connections(),
        getNode: async () =>
          ({ nodeId: ctx.instanceId, nodeName: ctx.nodeName, rooms: ctx.local.rooms, topics: ctx.local.topics }) satisfies NodeView,
        getConn: async (input) => {
          const id = (input as { id?: string } | undefined)?.id
          if (!id) throw new SuperLineError('BAD_REQUEST', 'getConn requires an id')
          const local = ctx.conns.find((cn) => cn.id === id)
          if (local) {
            return {
              descriptor: ctx.describe(local),
              ctx: safeSnapshot(local.ctx),
              data: safeSnapshot(local.data),
              env: maskEnv(local.env),
              ctxAvailable: true,
            } satisfies ConnView
          }
          const remote = await ctx.connectionById(id) // on another node: descriptor only, no ctx
          if (!remote) throw new SuperLineError('NOT_FOUND', `Unknown connection: ${id}`)
          return { descriptor: remote, ctxAvailable: false } satisfies ConnView
        },
        listCollections: () => buildCollectionInfos(ctx.contract, ctx.collectionInfos()),
        queryCollection: async (input) => {
          const { collection, ...query } = input as { collection: string } & CollectionQuery
          const def = ctx.contract.collections?.[collection]
          if (!def) throw new SuperLineError('NOT_FOUND', `Unknown collection: ${collection}`)
          if (isCrdtCollection(def)) {
            // CRDT document collection: open-by-id, not row-queryable — synthesize `{ id, ...snapshot }` rows
            // from the doc enumeration so the Collections view can browse them like any table. Filtering is
            // id-substring only; sorting is by id / created / updated. The per-doc created/updated ride each
            // DocSummary, so surface them under the reserved keys too.
            const handle = ctx.collection(collection) as unknown as ServerCrdtCollectionHandle
            const opts: DocListOpts = { limit: query.limit, offset: query.offset }
            const idContains = idContainsOf(query.filter)
            if (idContains) opts.idContains = idContains
            const sortBy = crdtSortBy(query.orderBy?.[0]?.field)
            if (sortBy) opts.sort = { by: sortBy, dir: query.orderBy?.[0]?.dir === 'desc' ? 'desc' : 'asc' }
            const docs = await handle.list(opts)
            const rows = await Promise.all(
              docs.map(async (d) =>
                withRowMeta(
                  { id: d.id, ...((await handle.read(d.id)) as Record<string, unknown> | undefined) },
                  { createdAt: d.createdAt, updatedAt: d.updatedAt },
                ),
              ),
            )
            return rows.map((r) => safeSnapshot(r))
          }
          const handle = ctx.collection(collection) // ACL/policy bypassed — the inspector is a trusted observer
          const key = def.key ?? 'id'
          const idOf = (r: Record<string, unknown>): string => String(r[key])
          const tsSort = query.orderBy?.find((o) => o.field === ROW_CREATED_AT || o.field === ROW_UPDATED_AT)
          if ((tsSort || filterMentionsTs(query.filter)) && handle.rowMeta) {
            // created/updated live outside the row data, so the backend can't filter or ORDER BY them — push the
            // schema-only part of the filter, merge the store timestamps, then apply the FULL filter + sort in JS
            // and slice the requested page (inspector-side, dev-scale).
            const all = (await handle.snapshot({ filter: stripTs(query.filter) })) as Record<string, unknown>[]
            const meta = await handle.rowMeta(all.map(idOf))
            let merged = all.map((r) => withRowMeta(r, meta[idOf(r)]) as Record<string, unknown>)
            if (query.filter) merged = merged.filter((r) => matchesFilter(query.filter, r)) // re-check incl. timestamps
            if (tsSort) {
              const dir = tsSort.dir === 'desc' ? -1 : 1
              merged.sort((a, b) => (((a[tsSort.field] as number) ?? 0) - ((b[tsSort.field] as number) ?? 0)) * dir)
            }
            const offset = query.offset ?? 0
            const page = query.limit != null ? merged.slice(offset, offset + query.limit) : merged.slice(offset)
            return page.map((r) => safeSnapshot(r))
          }
          const rows = (await handle.snapshot(query)) as Record<string, unknown>[] // filter + schema-field sort push down
          const meta = handle.rowMeta ? await handle.rowMeta(rows.map(idOf)) : {}
          return rows.map((r) => safeSnapshot(withRowMeta(r, meta[idOf(r)])))
        },
      }),
    },
  }
}
