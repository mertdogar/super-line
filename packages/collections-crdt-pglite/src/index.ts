import { PGlite } from '@electric-sql/pglite'
import { live } from '@electric-sql/pglite/live'
import type { Change, PGliteWithLive } from '@electric-sql/pglite/live'
import { electricSync } from '@electric-sql/pglite-sync'
import type { PGliteWithSync } from '@electric-sql/pglite-sync'
import postgres from 'postgres'
import { SuperLineError, removeAtPath } from '@super-line/core'
import type { CrdtCollectionStore, CrdtServerReplica, DocChange, DocOptions, DocSummary } from '@super-line/core'
import { StoreValue, type StoreMode } from '@super-store/store'

// The self-clustering CRDT-document-collection backend (ADR-0007): the `clustering:'self'` sibling of
// `collections-crdt-memory`/`-libsql`, and the relocation of `@super-line/store-sync-pglite` onto the
// CrdtCollectionStore seam — one backend serving every CRDT collection, keyed by (collection, id), with the
// stored ACL removed (access is server-side policy callbacks) and a **validate-before-commit** gate added to
// `apply`. Single-row + Electric can't merge (Electric ships whole rows; concurrent writers clobber), so the
// transport is an append-only **Yjs op-log**: every delta is an immutable INSERT that Electric ships to every
// node, each folding it into an in-memory super-store doc (`applyUpdate` is order-independent → convergence).
// That live in-memory doc also makes `open()`/`CrdtServerReplica` work (sync `getSnapshot` reads memory).

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const SERVER_ORIGIN = 'server'
// Sentinel origin marking a compaction baseline row (a full encodeState() superseding the rows it folded).
// Baselines fold like any delta but are not re-counted toward compaction nor re-fanned as a user change. Must be
// plain UTF-8 text (Postgres text columns reject NUL) and not collide with real origins ('server'/'agent:N'/ids).
const BASELINE_ORIGIN = 'sl-baseline'

type Doc = StoreValue<Record<string, unknown>, StoreMode>
/** A local PGlite with the `live` extension; `sync` is present when the backend creates its own Electric replica. */
type StoreDb = PGliteWithLive & { sync?: PGliteWithSync['sync'] }
// Electric's re-sync/compaction can deliver a PARTIAL live.changes row (only the key + changed columns), so the
// routing columns and delta come back null on those — model them nullable and skip such rows (they carry no delta).
type UpdateRow = { seq: number; collection: string | null; res_id: string | null; update: string | null; origin: string | null }
type MetaRow = { pk: string; collection: string; id: string }

/** Options for {@link crdtPgliteCollections}. */
export interface CrdtPgliteCollectionsOptions {
  /** Connection string for the central Postgres — source of truth for the op-log + existence. */
  pgUrl: string
  /** Electric shape endpoint (e.g. `http://localhost:3000/v1/shape`). Omit to disable sync (tests feed the replica). */
  electricUrl?: string
  /** Table prefix: creates `<table>` (existence + materialized snapshot) and `<table>_updates` (the op-log). Default `crdt_docs`. */
  table?: string
  /** Advanced/testing: supply the local PGlite replica (needs the `live` extension; add `electricSync` for real sync). */
  db?: PGliteWithLive
  /**
   * Per-collection doc mode/opaque paths, resolved on the fold path (Electric → live.changes) where no per-call
   * `DocOptions` is available. MUST agree with the collection's `crdt` DocOptions on the contract (the drift rule).
   */
  docOptions?: (collection: string) => DocOptions | undefined
  /**
   * Op-log compaction: fold the log → materialize `<table>.data` + a baseline row → trim superseded rows. Bounds
   * op-log growth and keeps a (debounced, eventually-consistent) snapshot in `<table>.data`. `false` disables it.
   */
  compact?: false | { everyNUpdates?: number; debounceMs?: number }
  /**
   * Called when a background op-log append (a server co-write through `open()`) fails to persist. Those writes are
   * synchronous (`CrdtServerReplica` returns void), so the INSERT can't reject to the caller — this is the only
   * place the failure is observable. Defaults to `console.error`.
   */
  onError?: (err: unknown, ctx: { op: 'append'; n: string; id: string }) => void
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
// In-memory doc key. NUL-free, injective (the length prefix delimits the collection), so (collection, id) never collides.
const dkey = (n: string, id: string): string => `${n.length}:${n}${id}`

/**
 * The self-clustering CRDT document-collection backend (`clustering:'self'`). Client writes append a Yjs delta to
 * a central `<table>_updates` op-log — gated by validate-before-commit at the ingress node; Electric streams the
 * op-log to each node's in-memory PGlite replica, whose `live.changes` folds every delta into a per-doc super-store
 * doc and surfaces it through {@link CrdtCollectionStore.onChange} (core fans to LOCAL subscribers only). Pass the
 * same `docOptions` the contract declares. Pair with `crdtCollectionsClient()` on the client.
 */
export async function crdtPgliteCollections(opts: CrdtPgliteCollectionsOptions): Promise<CrdtCollectionStore> {
  const meta = opts.table ?? 'crdt_docs'
  if (!IDENT.test(meta)) throw new Error(`Invalid table name: ${meta}`)
  const ups = `${meta}_updates`
  // Postgres truncates identifiers to 63 bytes; guard the derived name so `<meta>_updates` can't collide/truncate.
  if (ups.length > 63) throw new Error(`Table name too long: "${meta}" — "${ups}" exceeds Postgres' 63-char limit`)

  const NOW_MS = '(extract(epoch from clock_timestamp())*1000)::bigint'
  const ddlMeta = `CREATE TABLE IF NOT EXISTS "${meta}" (collection text NOT NULL, id text NOT NULL, origin text, data jsonb, created_at bigint NOT NULL DEFAULT ${NOW_MS}, updated_at bigint NOT NULL DEFAULT ${NOW_MS}, PRIMARY KEY (collection, id))`
  const ddlUps = `CREATE TABLE IF NOT EXISTS "${ups}" (seq bigserial PRIMARY KEY, collection text NOT NULL, res_id text NOT NULL, update text NOT NULL, origin text)`

  const docOptions = opts.docOptions ?? ((): DocOptions | undefined => undefined)

  // Central Postgres — the op-log + strong existence.
  const sql = postgres(opts.pgUrl, { prepare: false, onnotice: () => {} })
  // CREATE TABLE IF NOT EXISTS isn't race-safe across nodes booting together against the one shared Postgres.
  // Swallow only duplicate-on-race codes — duplicate_table / duplicate_object(rowtype) / catalog unique_violation.
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

  const changeCbs = new Set<(c: DocChange) => void>()
  const deleteCbs = new Set<(n: string, id: string) => void>()
  const onError = opts.onError ?? ((err: unknown, ctx: { op: string; n: string; id: string }): void => console.error(`[collections-crdt-pglite] ${ctx.op} failed for ${ctx.n}/${ctx.id} (write not replicated):`, err))

  // One in-memory Yjs doc per (collection, id), materialized by folding the op-log. The append-listener turns
  // this node's own LOCAL writes (server co-writes via open()) into op-log rows; remote merges (applyUpdate) are
  // tagged not-local and never re-appended.
  const docs = new Map<string, Doc>()
  let currentOrigin = SERVER_ORIGIN // origin of the in-progress local write; read synchronously by the append-listener
  const getDoc = (n: string, id: string): Doc => {
    const k = dkey(n, id)
    const existing = docs.get(k)
    if (existing) return existing
    const d = new StoreValue<Record<string, unknown>, StoreMode>({}, docOptions(n))
    d.encodeState() // force-bind before wiring so the bind update isn't appended
    d.onUpdate((update, m) => {
      if (!m.local) return // remote merges are folded elsewhere; only THIS node's writes get appended
      const origin = currentOrigin
      // Fire-and-forget: CrdtServerReplica.set/update/delete are synchronous (void), so this INSERT can't reject to
      // the caller. Surface a failure via onError instead of swallowing it — a silently-dropped server co-write is
      // data loss (the in-memory doc has it; no other node ever will).
      void sql`
        WITH ins AS (INSERT INTO ${sql(ups)} (collection, res_id, update, origin) VALUES (${n}, ${id}, ${b64(update)}, ${origin}))
        UPDATE ${sql(meta)} SET updated_at = (extract(epoch from clock_timestamp())*1000)::bigint WHERE collection = ${n} AND id = ${id}
      `.catch((err) => onError(err, { op: 'append', n, id }))
    })
    docs.set(k, d)
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

  // Fold a doc's op-log from CENTRAL into a fresh scratch — the authoritative current state, used as the
  // validate-before-commit baseline (correct even before Electric has streamed the rows to this node).
  const foldScratch = async (n: string, id: string): Promise<Doc> => {
    const scratch = new StoreValue<Record<string, unknown>, StoreMode>({}, docOptions(n))
    const rows = await sql`SELECT update FROM ${sql(ups)} WHERE collection = ${n} AND res_id = ${id} ORDER BY seq`
    for (const r of rows) scratch.applyUpdate(fromB64(r.update as string))
    return scratch
  }

  // Strong catch-up that MATERIALIZES: fold a doc's central op-log INTO its in-memory doc, so a later open()/
  // co-write shares this seed (a co-writer opening an unseeded doc would produce deltas that never merge with the
  // seeded state). Idempotent vs the live fold (Yjs applyUpdate). Unlike foldScratch (a throwaway copy for apply()'s
  // validate-before-commit, which must not mutate the shared doc).
  const foldFromCentral = async (n: string, id: string): Promise<Doc> => {
    const d = getDoc(n, id)
    const rows = await sql`SELECT update FROM ${sql(ups)} WHERE collection = ${n} AND res_id = ${id} ORDER BY seq`
    for (const r of rows) d.applyUpdate(fromB64(r.update as string))
    return d
  }

  // ---- op-log compaction: fold → materialize `<meta>.data` + a baseline row → trim superseded rows. Any node may
  // trigger (each folds every Electric-delivered append); two nodes compacting the same doc is BENIGN (same fold,
  // idempotent baseline, commutative `DELETE … <= maxSeq`), so no cross-node lock — only a per-node `compacting` set.
  const compactCfg = opts.compact === false ? null : { everyN: opts.compact?.everyNUpdates ?? 200, debounceMs: opts.compact?.debounceMs ?? 2000 }
  const appendsSince = new Map<string, number>()
  const compacting = new Set<string>()
  const compactTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const compact = async (n: string, id: string): Promise<void> => {
    await sql.begin(async (tx) => {
      const rows = await tx`SELECT seq, update FROM ${tx(ups)} WHERE collection = ${n} AND res_id = ${id} ORDER BY seq`
      if (rows.length < 2) return // nothing to fold down
      const maxSeq = rows[rows.length - 1]?.seq as number
      const doc = new StoreValue<Record<string, unknown>, StoreMode>({}, docOptions(n))
      for (const r of rows) doc.applyUpdate(fromB64(r.update as string))
      const baseline = b64(doc.encodeState()) // a single full-state update that supersedes everything ≤ maxSeq
      const snapshot = doc.getSnapshot()
      doc.dispose()
      // Order matters: write the baseline (higher seq) BEFORE deleting, so a folder always sees a self-sufficient
      // log. Rows appended during this tx have seq > maxSeq and survive (Yjs folds them on top of the baseline).
      await tx`INSERT INTO ${tx(ups)} (collection, res_id, update, origin) VALUES (${n}, ${id}, ${baseline}, ${BASELINE_ORIGIN})`
      await tx`DELETE FROM ${tx(ups)} WHERE collection = ${n} AND res_id = ${id} AND seq <= ${maxSeq}`
      await tx`UPDATE ${tx(meta)} SET data = ${asJson(snapshot)} WHERE collection = ${n} AND id = ${id}`
    })
  }
  const scheduleCompact = (n: string, id: string): void => {
    if (!compactCfg) return
    const k = dkey(n, id)
    const cnt = (appendsSince.get(k) ?? 0) + 1
    appendsSince.set(k, cnt)
    const fire = (): void => {
      compactTimers.delete(k)
      appendsSince.set(k, 0)
      if (compacting.has(k)) return
      compacting.add(k)
      void compact(n, id)
        .catch((err) => onError(err, { op: 'append', n, id })) // surface, but a failed compaction is non-fatal (log grows)
        .finally(() => compacting.delete(k))
    }
    const existing = compactTimers.get(k)
    if (existing) clearTimeout(existing)
    if (cnt >= compactCfg.everyN) {
      fire() // sustained load: cap growth at everyN even if edits never pause
      return
    }
    const t = setTimeout(fire, compactCfg.debounceMs) // idle: materialize shortly after edits settle
    t.unref?.()
    compactTimers.set(k, t)
  }

  // Fold the op-log: each appended row → applyUpdate into the doc (idempotent for our own rows) and emit onChange
  // carrying the delta + origin (echo-break is the client's job, by origin). Seed/baseline rows arrive as INSERTs
  // too, so a booting node rehydrates every doc from the log. A poison row (un-decodable) is logged and skipped.
  const upsSub = await db.live.changes<UpdateRow>(`SELECT seq, collection, res_id, update, origin FROM "${ups}"`, [], 'seq', (changes: Array<Change<UpdateRow>>) => {
    for (const ch of changes) {
      if (ch.__op__ !== 'INSERT' && ch.__op__ !== 'UPDATE') continue
      // A partial re-sync row (only the key + a changed column like `origin`/`updated_at`) carries no delta and no
      // routing columns — `collection`/`res_id`/`update` are null. Skip it: a real op-log row always arrives
      // full-column, and `getDoc(null)` would otherwise throw and drop the rest of this batch's real deltas.
      if (ch.collection == null || ch.res_id == null || ch.update == null) continue
      try {
        getDoc(ch.collection, ch.res_id).applyUpdate(fromB64(ch.update))
        if (ch.origin === BASELINE_ORIGIN) continue // baseline: folded for state, but not a user change — don't fan or count
        const change: DocChange = { n: ch.collection, id: ch.res_id, update: ch.update, origin: ch.origin ?? '' }
        for (const cb of changeCbs) cb(change)
        scheduleCompact(ch.collection, ch.res_id)
      } catch (err) {
        onError(err, { op: 'append', n: ch.collection, id: ch.res_id })
      }
    }
  })

  // Doc deletes: a removed meta row → drop the local doc + onDelete on every node. The synthetic `pk` is a single
  // unique key for live.changes diffing over the composite (collection, id) primary key.
  const metaSub = await db.live.changes<MetaRow>(`SELECT (length(collection) || ':' || collection || id) AS pk, collection, id FROM "${meta}"`, [], 'pk', (changes: Array<Change<MetaRow>>) => {
    for (const ch of changes) {
      if (ch.__op__ !== 'DELETE') continue
      // On DELETE, live.changes populates only the key (`pk`) — recover (collection, id) from its length prefix.
      const colon = ch.pk.indexOf(':')
      const len = Number(ch.pk.slice(0, colon))
      const collection = ch.pk.slice(colon + 1, colon + 1 + len)
      const id = ch.pk.slice(colon + 1 + len)
      const k = dkey(collection, id)
      docs.get(k)?.dispose()
      docs.delete(k)
      for (const cb of deleteCbs) cb(collection, id)
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
              primaryKey: t === meta ? ['collection', 'id'] : ['seq'],
              shapeKey: null,
            }),
          ),
        )
      : []

  return {
    clustering: 'self',
    async read(n, id) {
      const rows = await sql`SELECT 1 FROM ${sql(meta)} WHERE collection = ${n} AND id = ${id}`
      if (rows.count === 0) return undefined
      // Prefer the live in-memory doc (kept current by the fold feed, and reflecting a co-writer's own edits
      // immediately); else strong-fold from central AND materialize it, so a later open()/co-write shares this seed.
      const doc = docs.get(dkey(n, id)) ?? (await foldFromCentral(n, id))
      return b64(doc.encodeState())
    },
    async create(n, id, data, docOpts) {
      const seedDoc = new StoreValue<Record<string, unknown>, StoreMode>((data ?? {}) as Record<string, unknown>, docOpts ?? docOptions(n))
      const seed = b64(seedDoc.encodeState()) // the initial doc state, the first op-log row
      const snapshot = seedDoc.getSnapshot() // also the initial materialized `data`
      seedDoc.dispose()
      // One transaction: the meta row and its seed op-log row land together, so a seeded doc is never left with no
      // seed (an orphan meta row that read()s as empty forever). CONFLICT short-circuits before the seed.
      await sql.begin(async (tx) => {
        const res = await tx`INSERT INTO ${tx(meta)} (collection, id, origin, data)
          VALUES (${n}, ${id}, ${null}, ${asJson(snapshot)})
          ON CONFLICT (collection, id) DO NOTHING`
        if (res.count === 0) throw new SuperLineError('CONFLICT', `Document already exists: ${n}/${id}`)
        await tx`INSERT INTO ${tx(ups)} (collection, res_id, update, origin) VALUES (${n}, ${id}, ${seed}, ${null})`
      })
      // Materialize on the creating node so its read()/open() are immediately correct (the Electric echo of the
      // seed re-applies idempotently; other nodes fold it when Electric delivers it).
      getDoc(n, id).applyUpdate(fromB64(seed))
    },
    async apply(change, docOpts, validate) {
      const { n, id, update, origin } = change
      // Existence gate first — a write to a missing/deleted id raises NOT_FOUND, not an orphan doc + op-log rows.
      const metaRows = await sql`SELECT 1 FROM ${sql(meta)} WHERE collection = ${n} AND id = ${id}`
      if (metaRows.count === 0) throw new SuperLineError('NOT_FOUND', `No document: ${n}/${id}`)
      // Validate-before-commit: fold the authoritative central state + the incoming delta on a scratch, snapshot to
      // plaintext, and let the server validate. A throw aborts before any INSERT — nothing is committed or fanned.
      const scratch = await foldScratch(n, id)
      try {
        scratch.applyUpdate(fromB64(update))
        validate(scratch.getSnapshot())
      } finally {
        scratch.dispose()
      }
      // Commit: append to the op-log (→ Electric → fold on every node incl. here). Folding is Electric's job — apply
      // only persists, so the writer node's doc stays consistent (no partial-state optimism).
      await sql`INSERT INTO ${sql(ups)} (collection, res_id, update, origin) VALUES (${n}, ${id}, ${update}, ${origin})`
      await sql`UPDATE ${sql(meta)} SET updated_at = (extract(epoch from clock_timestamp())*1000)::bigint WHERE collection = ${n} AND id = ${id}`
    },
    open(n, id, openOpts) {
      const doc = getDoc(n, id)
      const origin = openOpts?.origin ?? SERVER_ORIGIN
      const subs = new Set<() => void>()
      // Mutate the canonical in-memory doc with this replica's origin; the append-listener turns the produced delta
      // into an op-log row (→ Electric → every node). Synchronous so the origin can't bleed across writes.
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
      } satisfies CrdtServerReplica
    },
    async delete(n, id) {
      // One transaction: the meta row (→ onDelete) and its op-log rows go together, so a crash can't leave orphan
      // op-log rows for an id with no meta row (which would resurrect on a delete-then-recreate).
      await sql.begin(async (tx) => {
        await tx`DELETE FROM ${tx(meta)} WHERE collection = ${n} AND id = ${id}` // → live.changes DELETE → onDelete on every node
        await tx`DELETE FROM ${tx(ups)} WHERE collection = ${n} AND res_id = ${id}` // GC the op-log for the gone doc
      })
    },
    async list(n, listOpts) {
      const { idContains, sort, limit, offset = 0 } = listOpts ?? {}
      const by = sort?.by ?? 'id'
      const dir = sort?.dir === 'desc' ? sql`DESC` : sql`ASC`
      // COLLATE "C" = byte/code-point order (NOT locale), to match the memory backend's raw string compare.
      const orderCol = { id: sql`id COLLATE "C"`, createdAt: sql`created_at`, updatedAt: sql`updated_at` }[by]
      const tie = by === 'id' ? sql`` : sql`, id COLLATE "C" ASC` // deterministic secondary key on non-id sorts
      const idCond = idContains ? sql`AND strpos(id, ${idContains}) > 0` : sql`` // literal substring (like JS .includes), not LIKE
      const rows = await sql`
        SELECT id, created_at, updated_at FROM ${sql(meta)}
        WHERE collection = ${n} ${idCond}
        ORDER BY ${orderCol} ${dir}${tie}
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
        OFFSET ${offset}`
      return rows.map((r) => ({ id: r.id as string, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }) satisfies DocSummary)
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
