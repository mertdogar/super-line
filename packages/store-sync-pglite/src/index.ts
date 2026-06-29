import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import type { Change, PGliteWithLive } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'
import type { PGliteWithSync } from '@electric-sql/pglite-sync'
import postgres from 'postgres'
import { SuperLineError, removeAtPath } from '@super-line/core'
import type { AccessRules, Resource, ServerReplica, ServerStore, StoreChange } from '@super-line/core'
import { StoreValue, type StoreMode } from '@super-store/store'

// A genuine CRDT Store whose cross-node sync is owned by the store itself (ElectricSQL), not super-line's
// adapter — the CRDT sibling of `@super-line/store-pglite` (which is single-row LWW). Single-row + Electric
// can't merge (Electric ships whole rows; concurrent writers clobber), so the transport is an append-only
// **Yjs op-log**: every delta is an immutable INSERT that Electric ships to every node, each folding it into
// an in-memory super-store doc (`applyUpdate` is order-independent → convergence, no clobber). That live
// in-memory doc is also what makes `open()`/`ServerReplica` work here (sync `getSnapshot` reads memory, not
// the async driver — the reason `store-pglite` deferred it). Pair it with `syncStoreClient()` on the client.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SERVER_ORIGIN = 'server'
// Sentinel origin marking a compaction baseline row (a full encodeState() that supersedes the rows it folded).
// Baselines fold like any delta but are not re-counted toward compaction nor re-fanned as a user change. Must be
// plain UTF-8 text (Postgres text columns reject NUL) and not collide with real origins ('server'/'agent:N'/ids).
const BASELINE_ORIGIN = 'sl-baseline'

type Doc = StoreValue<Record<string, unknown>, StoreMode>
/** A local PGlite with the `live` extension; `sync` is present when the store creates its own Electric replica. */
type StoreDb = PGliteWithLive & { sync?: PGliteWithSync['sync'] }
type UpdateRow = { seq: number; res_id: string; update: string; origin: string | null }
type MetaRow = { id: string }

/** Per-resource super-store config (mode + opaque paths). Supply the SAME resolver to the client's
 * `syncStoreClient` so both halves build each resource's Yjs doc identically (no mode drift). */
export interface DocOptions {
  mode?: 'shallow' | 'document'
  opaque?: string[]
}

/** Options for {@link syncPgliteStoreServer}. */
export interface SyncPgliteStoreOptions {
  /** Connection string for the central Postgres — source of truth for the op-log + strong ACL/existence. */
  pgUrl: string
  /** Electric shape endpoint (e.g. `http://localhost:3000/v1/shape`). Omit to disable sync (tests feed the replica). */
  electricUrl?: string
  /** Table prefix: creates `<table>` (existence + ACL) and `<table>_updates` (the Yjs op-log). Default `resources`. */
  table?: string
  /** Advanced/testing: supply the local PGlite replica (needs the `live` extension; add `electricSync` for real sync). */
  db?: PGliteWithLive
  /** Per-resource doc mode — must match the client's `syncStoreClient({ resolveOptions })`. */
  resolveOptions?: (id: string) => DocOptions | undefined
  /**
   * Op-log compaction: fold the log → materialize `<table>.data` (SQL-queryable board) + a baseline row →
   * trim superseded rows. Bounds op-log growth and keeps a (debounced, eventually-consistent) snapshot in
   * `<table>.data`. `false` disables it (pure append-only log). Single-writer per resource across the cluster.
   */
  compact?: false | { everyNUpdates?: number; debounceMs?: number }
  /**
   * Called when a background op-log append (a server co-write through `open()`/`apply`-object) fails to persist.
   * Those writes are synchronous (`ServerReplica` returns void), so the INSERT can't reject to the caller — this
   * is the only place the failure is observable. Defaults to `console.error`.
   */
  onError?: (err: unknown, ctx: { op: 'append'; id: string }) => void
}

const b64 = (u: Uint8Array): string => {
  let s = ''
  for (const byte of u) s += String.fromCharCode(byte)
  return btoa(s)
}
const fromB64 = (s: string): Uint8Array => {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/**
 * The self-clustering, **CRDT** server half (`clustering:'self'`, `model:'crdt'`). Writes append a Yjs delta
 * to a central `<table>_updates` op-log; Electric streams the op-log to each node's in-memory PGlite replica,
 * whose `live.changes` folds every delta into a per-resource super-store doc and surfaces it through
 * {@link ServerStore.onChange} — which core fans to LOCAL subscribers only. Strong ACL/existence reads hit
 * central Postgres. `open()` returns a reactive {@link ServerReplica} over the in-memory doc (the agent
 * co-writer). Pair with `syncStoreClient()` on the client.
 */
export async function syncPgliteStoreServer(opts: SyncPgliteStoreOptions): Promise<ServerStore> {
  const meta = opts.table ?? 'resources'
  if (!IDENT.test(meta)) throw new Error(`Invalid table name: ${meta}`)
  const ups = `${meta}_updates`
  // Postgres truncates identifiers to 63 bytes; a too-long `meta` would make `<meta>_updates` collide with (or
  // truncate into) the meta table. Guard the derived name, not just the base.
  if (ups.length > 63) throw new Error(`Table name too long: "${meta}" — "${ups}" exceeds Postgres' 63-char limit`)

  const ddlMeta = `CREATE TABLE IF NOT EXISTS "${meta}" (id text PRIMARY KEY, access jsonb NOT NULL, origin text, data jsonb)`
  const ddlUps = `CREATE TABLE IF NOT EXISTS "${ups}" (seq bigserial PRIMARY KEY, res_id text NOT NULL, update text NOT NULL, origin text)`

  // Central Postgres — the op-log + strong ACL/existence.
  const sql = postgres(opts.pgUrl, { prepare: false, onnotice: () => {} })
  // CREATE TABLE IF NOT EXISTS isn't race-safe across nodes booting together against the one shared Postgres:
  // a peer can create the relation (and its implicit rowtype) in the window after our existence check. Swallow
  // only those duplicate-on-race codes — duplicate_table / duplicate_object(rowtype) / catalog unique_violation.
  const RACE_OK = new Set(['42P07', '42710', '23505'])
  for (const ddl of [ddlMeta, ddlUps]) {
    try {
      await sql.unsafe(ddl)
    } catch (err) {
      if (!RACE_OK.has((err as { code?: string }).code ?? '')) throw err
    }
  }
  const asJson = (v: unknown): ReturnType<typeof sql.json> => sql.json(v as Parameters<typeof sql.json>[0])

  // Local in-memory PGlite — the reactive op-log feed (Electric sync → live.changes). Ephemeral: re-syncs on boot.
  const ownsDb = !opts.db
  const db = (opts.db ?? (await PGlite.create({ extensions: { live, sync: electricSync() } }))) as StoreDb
  await db.exec(ddlMeta)
  await db.exec(ddlUps)

  const changeCbs = new Set<(c: StoreChange) => void>()
  const deleteCbs = new Set<(id: string) => void>()
  const onError = opts.onError ?? ((err: unknown, ctx: { op: string; id: string }): void => console.error(`[store-sync-pglite] ${ctx.op} failed for ${ctx.id} (write not replicated):`, err))

  // One in-memory Yjs doc per resource, materialized by folding the op-log. The append-listener turns this
  // node's own LOCAL writes (server co-writes via open()) into op-log rows; remote merges (applyUpdate) are
  // tagged not-local and never re-appended.
  const docs = new Map<string, Doc>()
  let currentOrigin = SERVER_ORIGIN // origin of the in-progress local write; read synchronously by the append-listener
  const getDoc = (id: string): Doc => {
    const existing = docs.get(id)
    if (existing) return existing
    const d = new StoreValue<Record<string, unknown>, StoreMode>({}, opts.resolveOptions?.(id))
    d.encodeState() // force-bind before wiring so the bind update isn't appended
    d.onUpdate((update, m) => {
      if (!m.local) return // remote merges are folded elsewhere; only THIS node's writes get appended
      const origin = currentOrigin
      // Fire-and-forget: ServerReplica.set/update/delete are synchronous (void), so this INSERT can't reject to
      // the caller. Surface a failure via onError instead of swallowing it — a silently-dropped server co-write
      // is data loss (the in-memory doc has it; no other node ever will).
      void sql`INSERT INTO ${sql(ups)} (res_id, update, origin) VALUES (${id}, ${b64(update)}, ${origin})`.catch((err) => onError(err, { op: 'append', id }))
    })
    docs.set(id, d)
    return d
  }
  const withOrigin = (origin: string, fn: () => void): void => {
    currentOrigin = origin
    try {
      fn()
    } finally {
      currentOrigin = SERVER_ORIGIN
    }
  }

  // Strong catch-up: fold a resource's op-log from CENTRAL when this node hasn't materialized it yet (e.g. a
  // first read before Electric has streamed the rows in). Idempotent vs the live fold (Yjs applyUpdate).
  const foldFromCentral = async (id: string): Promise<Doc> => {
    const d = getDoc(id)
    const rows = await sql`SELECT update FROM ${sql(ups)} WHERE res_id = ${id} ORDER BY seq`
    for (const r of rows) d.applyUpdate(fromB64(r.update as string))
    return d
  }

  // ---- op-log compaction: fold → materialize `<meta>.data` + a baseline row → trim superseded rows. Bounds
  // op-log growth and gives a SQL-queryable (eventually-consistent) board. Each node counts the appends it folds
  // (Electric delivers every append to every node), so any node may trigger. No cross-node lock is needed: two
  // nodes compacting the same resource is BENIGN — both fold to the same state, baselines are idempotent and
  // `DELETE … <= maxSeq` is commutative, so the worst case is one redundant baseline row (the per-node `compacting`
  // set prevents a node overlapping itself).
  const compactCfg = opts.compact === false ? null : { everyN: opts.compact?.everyNUpdates ?? 200, debounceMs: opts.compact?.debounceMs ?? 2000 }
  const appendsSince = new Map<string, number>()
  const compacting = new Set<string>()
  const compactTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const compact = async (id: string): Promise<void> => {
    await sql.begin(async (tx) => {
      const rows = await tx`SELECT seq, update FROM ${tx(ups)} WHERE res_id = ${id} ORDER BY seq`
      if (rows.length < 2) return // nothing to fold down
      const maxSeq = rows[rows.length - 1]?.seq as number
      const doc = new StoreValue<Record<string, unknown>, StoreMode>({}, opts.resolveOptions?.(id))
      for (const r of rows) doc.applyUpdate(fromB64(r.update as string))
      const baseline = b64(doc.encodeState()) // a single full-state update that supersedes everything ≤ maxSeq
      const snapshot = doc.getSnapshot()
      doc.dispose()
      // Order matters: write the baseline (higher seq) BEFORE deleting, so a folder always sees a self-sufficient
      // log. Rows appended during this tx have seq > maxSeq and survive (Yjs folds them on top of the baseline).
      await tx`INSERT INTO ${tx(ups)} (res_id, update, origin) VALUES (${id}, ${baseline}, ${BASELINE_ORIGIN})`
      await tx`DELETE FROM ${tx(ups)} WHERE res_id = ${id} AND seq <= ${maxSeq}`
      await tx`UPDATE ${tx(meta)} SET data = ${asJson(snapshot)} WHERE id = ${id}`
    })
  }
  const scheduleCompact = (id: string): void => {
    if (!compactCfg) return
    const n = (appendsSince.get(id) ?? 0) + 1
    appendsSince.set(id, n)
    const fire = (): void => {
      compactTimers.delete(id)
      appendsSince.set(id, 0)
      if (compacting.has(id)) return
      compacting.add(id)
      void compact(id)
        .catch((err) => onError(err, { op: 'append', id })) // surface, but a failed compaction is non-fatal (log keeps growing)
        .finally(() => compacting.delete(id))
    }
    const existing = compactTimers.get(id)
    if (existing) clearTimeout(existing)
    if (n >= compactCfg.everyN) {
      fire() // sustained load: cap growth at everyN even if edits never pause
      return
    }
    const t = setTimeout(fire, compactCfg.debounceMs) // idle: materialize shortly after edits settle
    t.unref?.()
    compactTimers.set(id, t)
  }

  // Fold the op-log: each appended row → applyUpdate into the doc (idempotent for our own rows) and emit
  // onChange carrying the delta + origin (echo-break is the client's job, by origin). Reset/initial rows
  // arrive as INSERTs too, so a booting node rehydrates every doc from the log. A poison row (un-decodable /
  // un-applyable) is logged and skipped so it can't wedge the whole feed.
  const upsSub = await db.live.changes<UpdateRow>(`SELECT seq, res_id, update, origin FROM "${ups}"`, [], 'seq', (changes: Array<Change<UpdateRow>>) => {
    for (const ch of changes) {
      if (ch.__op__ !== 'INSERT' && ch.__op__ !== 'UPDATE') continue
      try {
        getDoc(ch.res_id).applyUpdate(fromB64(ch.update))
        if (ch.origin === BASELINE_ORIGIN) continue // baseline: folded for state, but not a user change — don't fan or count
        const change: StoreChange = { id: ch.res_id, update: ch.update, origin: ch.origin ?? '' }
        for (const cb of changeCbs) cb(change)
        scheduleCompact(ch.res_id)
      } catch (err) {
        onError(err, { op: 'append', id: ch.res_id })
      }
    }
  })

  // Resource deletes: a removed meta row → drop the local doc + onDelete on every node.
  const metaSub = await db.live.changes<MetaRow>(`SELECT id FROM "${meta}"`, [], 'id', (changes: Array<Change<MetaRow>>) => {
    for (const ch of changes) {
      if (ch.__op__ !== 'DELETE') continue
      docs.get(ch.id)?.dispose()
      docs.delete(ch.id)
      for (const cb of deleteCbs) cb(ch.id)
    }
  })

  // Incoming sync from Electric (read-only Postgres → local replica): one shape per table. shapeKey null = ephemeral.
  const shapes =
    opts.electricUrl && db.sync
      ? await Promise.all(
          ([meta, ups] as const).map((t) =>
            (db.sync as NonNullable<StoreDb['sync']>).syncShapeToTable({
              shape: { url: opts.electricUrl as string, params: { table: t } },
              table: t,
              primaryKey: t === meta ? ['id'] : ['seq'],
              shapeKey: null,
            }),
          ),
        )
      : []

  return {
    clustering: 'self',
    model: 'crdt',
    async read(id) {
      const rows = await sql`SELECT access::text AS access FROM ${sql(meta)} WHERE id = ${id}`
      const row = rows[0]
      if (!row) return undefined
      const doc = docs.get(id) ?? (await foldFromCentral(id))
      return { id, data: b64(doc.encodeState()), accessRules: JSON.parse(row.access as string) as AccessRules } satisfies Resource
    },
    async create(id, data, accessRules) {
      const seedDoc = new StoreValue<Record<string, unknown>, StoreMode>((data ?? {}) as Record<string, unknown>, opts.resolveOptions?.(id))
      const seed = b64(seedDoc.encodeState()) // the initial doc state, the first op-log row
      const snapshot = seedDoc.getSnapshot() // also the initial materialized `data`
      seedDoc.dispose()
      // One transaction: the meta row and its seed op-log row land together, so a seeded resource is never left
      // with no seed (an orphan meta row that read()s as empty forever). CONFLICT short-circuits before the seed.
      await sql.begin(async (tx) => {
        const res = await tx`INSERT INTO ${tx(meta)} (id, access, origin, data)
          VALUES (${id}, ${asJson(accessRules)}, ${null}, ${asJson(snapshot)})
          ON CONFLICT (id) DO NOTHING`
        if (res.count === 0) throw new SuperLineError('CONFLICT', `Resource already exists: ${id}`)
        await tx`INSERT INTO ${tx(ups)} (res_id, update, origin) VALUES (${id}, ${seed}, ${null})`
      })
      // Materialize on the creating node so its read()/open() are immediately correct (the Electric echo of
      // the seed re-applies idempotently; other nodes fold it when Electric delivers it).
      getDoc(id).applyUpdate(fromB64(seed))
    },
    async apply(change) {
      // A server co-write through apply (object) — rare; the agent uses open(). Merge top-level keys. Gate on
      // existence first (like the string branch + both store siblings) so a write to a missing/deleted id raises
      // NOT_FOUND instead of fabricating an orphan doc + op-log rows with no meta row.
      if (typeof change.update !== 'string') {
        const rows = await sql`SELECT 1 FROM ${sql(meta)} WHERE id = ${change.id}`
        if (rows.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${change.id}`)
        withOrigin(change.origin, () => void getDoc(change.id).update(change.update as Record<string, unknown>))
        return
      }
      // A client delta (base64): append it iff the resource exists. Folding (here + on every node) is Electric's
      // job — apply only persists, so the writer node's doc stays consistent (no partial-state optimism).
      const res = await sql`INSERT INTO ${sql(ups)} (res_id, update, origin)
        SELECT ${change.id}, ${change.update}, ${change.origin}
        WHERE EXISTS (SELECT 1 FROM ${sql(meta)} WHERE id = ${change.id})`
      if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${change.id}`)
    },
    open(id, openOpts) {
      const doc = getDoc(id)
      const origin = openOpts?.origin ?? SERVER_ORIGIN
      const subs = new Set<() => void>()
      // Mutate the canonical in-memory doc with this replica's origin; the append-listener turns the produced
      // delta into an op-log row (→ Electric → every node). Synchronous so the origin can't bleed across writes.
      return {
        getSnapshot: () => doc.getSnapshot(),
        subscribe: (cb) => {
          const off = doc.subscribe(cb)
          subs.add(off)
          return () => {
            off()
            subs.delete(off)
          }
        },
        set: (value) => withOrigin(origin, () => void doc.set(value as Record<string, unknown>)),
        update: (partial) => withOrigin(origin, () => void doc.update(partial as Record<string, unknown>)),
        // Surgical key removal: read live state, drop the path, set() (diff-and-patch) — the only delete-capable
        // surface (update MERGES, so it can never remove a key). Atomic in-process.
        delete: (path) => withOrigin(origin, () => void doc.set(removeAtPath(doc.getSnapshot(), path) as Record<string, unknown>)),
        close: () => {
          for (const off of subs) off()
          subs.clear()
        },
      } satisfies ServerReplica
    },
    async setAccess(id, accessRules) {
      const res = await sql`UPDATE ${sql(meta)} SET access = ${asJson(accessRules)} WHERE id = ${id}`
      if (res.count === 0) throw new SuperLineError('NOT_FOUND', `No resource: ${id}`)
    },
    async delete(id) {
      // One transaction: the meta row (→ onDelete) and the op-log rows go together, so a crash can't leave op-log
      // rows for an id with no meta row (which would resurrect on a delete-then-recreate of the same id).
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ${tx(meta)} WHERE id = ${id}` // → live.changes DELETE → onDelete on every node
        await tx`DELETE FROM ${tx(ups)} WHERE res_id = ${id}` // GC the op-log for the gone resource
      })
    },
    async list() {
      const rows = await sql`SELECT id FROM ${sql(meta)}`
      return rows.map((r) => r.id as string)
    },
    onChange(cb) {
      changeCbs.add(cb)
      return () => changeCbs.delete(cb)
    },
    onDelete(cb) {
      deleteCbs.add(cb)
      return () => deleteCbs.delete(cb)
    },
    async close() {
      for (const t of compactTimers.values()) clearTimeout(t)
      compactTimers.clear()
      // sql holds a real network pool — release it even if replica teardown throws.
      try {
        await upsSub.unsubscribe()
        await metaSub.unsubscribe()
        for (const s of shapes) s.unsubscribe()
        if (ownsDb) await db.close()
      } finally {
        await sql.end()
      }
    },
  }
}
