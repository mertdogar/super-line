import {
  isCrdtCollection,
  SuperLineError,
  validate,
  validateSync,
  type CDChangeFrame,
  type CDCloseFrame,
  type CDDeleteFrame,
  type CDOpenFrame,
  type CDWriteFrame,
  type CrdtCollectionDef,
} from '@super-line/core'
import type {
  CollectionConn,
  CollectionHost,
  CollectionRuntimeConfig,
  CrdtCollectionPolicy,
  ServerCrdtCollectionHandle,
} from './types.js'

/** Per-CRDT-document fan-out channel: `d:<collection>:<id>`. Collections is this prefix's only user. */
export const CDOC = 'd:'

export interface CrdtCollections {
  onOpen(conn: CollectionConn, frame: CDOpenFrame): Promise<void>
  onWrite(conn: CollectionConn, frame: CDWriteFrame): Promise<void>
  onClose(conn: CollectionConn, frame: CDCloseFrame): void
  onRelay(channel: string, payload: string | Uint8Array): void
  handle(name: string): ServerCrdtCollectionHandle
}

/** Byte size of an opaque delta, for the `crdt.change` / `crdt.write` tap (the delta itself never crosses). */
const deltaBytes = (u: unknown): number =>
  typeof u === 'string' ? u.length : u instanceof Uint8Array ? u.byteLength : 0

/**
 * CRDT document collections (ADR-0007): per-doc fan-out channel (`d:<n>:<id>`), opaque base64 deltas,
 * validate-before-commit at ingress, guard-shaped policies (no stored ACL). Creation is server-authoritative
 * (Q10) — a client opens an existing doc; a missing doc is NOT_FOUND.
 *
 * Local delivery is **on receipt**, the mirror image of the row family: this module does NOT fan out on its own
 * store `onChange`. It publishes, and the Adapter's loopback comes back through {@link CrdtCollections.onRelay},
 * which forwards the raw bytes to local subscribers *before* consulting `own`. Filtering own-messages at the
 * Cluster would therefore break local delivery outright — which is why {@link Cluster} reports `own` and leaves
 * the policy here.
 */
export function createCrdtCollections(config: CollectionRuntimeConfig, host: CollectionHost): CrdtCollections {
  const { crdtStore: store, defs, policies } = config
  // true while applying a relayed change, so its onChange doesn't re-publish (echo loop). Sound only because a
  // relay backend applies synchronously — see CrdtCollectionStore.apply. Async would clear it before onChange.
  let relaying = false

  const defOf = (n: string): CrdtCollectionDef | undefined => {
    const d = defs[n]
    return d && isCrdtCollection(d) ? d : undefined
  }
  const policyOf = (n: string): CrdtCollectionPolicy<unknown, unknown> | undefined =>
    policies[n] as CrdtCollectionPolicy<unknown, unknown> | undefined

  const principalOf = (conn: CollectionConn): string => conn.principal ?? conn.id
  const channelOf = (n: string, id: string): string => CDOC + n + ':' + id

  function missing(conn: CollectionConn, i: number, n: string): boolean {
    if (store && defOf(n)) return false
    conn.send({ t: 'err', i, code: 'NOT_FOUND', m: `Unknown CRDT collection: ${n}` })
    return true
  }

  async function onOpen(conn: CollectionConn, frame: CDOpenFrame): Promise<void> {
    if (missing(conn, frame.i, frame.n)) return
    const s = store!
    await host.dispatch(
      conn,
      frame.i,
      { kind: 'subscribe', name: `collection:${frame.n}/${frame.id}`, conn },
      async () => {
        const state = await s.read(frame.n, frame.id)
        if (state === undefined) throw new SuperLineError('NOT_FOUND', `No document: ${frame.n}/${frame.id}`)
        const policy = policyOf(frame.n)
        if (!policy?.read) throw new SuperLineError('FORBIDDEN', `Read denied: ${frame.n}/${frame.id}`) // deny-by-default
        const replica = s.open(frame.n, frame.id)
        const snapshot = replica.getSnapshot()
        replica.close()
        if (!(await policy.read(principalOf(conn), frame.id, snapshot, conn.ctx)))
          throw new SuperLineError('FORBIDDEN', `Read denied: ${frame.n}/${frame.id}`)
        await host.channels.join(conn, channelOf(frame.n, frame.id))
        host.tap(() => ({ type: 'crdt.open', connId: conn.id, n: frame.n, id: frame.id, ok: true, snapshot }))
        conn.send({ t: 'res', i: frame.i, d: state }) // catch-up: full Yjs state
      },
      (error) => host.tap(() => ({ type: 'crdt.open', connId: conn.id, n: frame.n, id: frame.id, ok: false, error })),
    )
  }

  async function onWrite(conn: CollectionConn, frame: CDWriteFrame): Promise<void> {
    if (missing(conn, frame.i, frame.n)) return
    const s = store!
    const def = defOf(frame.n)!
    const bytes = typeof frame.u === 'string' ? frame.u.length : 0
    await host.dispatch(
      conn,
      frame.i,
      { kind: 'request', name: `collection:${frame.n}/${frame.id}`, conn },
      async () => {
        const policy = policyOf(frame.n)
        if (!policy?.write) throw new SuperLineError('FORBIDDEN', `Write denied: ${frame.n}/${frame.id}`) // deny-by-default
        if (!(await policy.write(principalOf(conn), frame.id, conn.ctx)))
          throw new SuperLineError('FORBIDDEN', `Write denied: ${frame.n}/${frame.id}`)
        // validate-before-commit: the backend merges onto a scratch copy and calls this with the post-merge
        // plaintext; a throw aborts the commit (nothing fanned) and surfaces as an err → the client resyncs.
        let snapshot: unknown
        await s.apply({ n: frame.n, id: frame.id, update: frame.u as string, origin: frame.o }, def.crdt, (snap) => {
          snapshot = snap
          validateSync(def.schema, snap)
        })
        host.tap(() => ({
          type: 'crdt.write',
          connId: conn.id,
          n: frame.n,
          id: frame.id,
          origin: frame.o,
          deltaBytes: bytes,
          ok: true,
          snapshot,
        }))
        conn.send({ t: 'res', i: frame.i, d: null })
      },
      (error) =>
        host.tap(() => ({
          type: 'crdt.write',
          connId: conn.id,
          n: frame.n,
          id: frame.id,
          origin: frame.o,
          deltaBytes: bytes,
          ok: false,
          error,
        })),
    )
  }

  function onClose(conn: CollectionConn, frame: CDCloseFrame): void {
    if (!defOf(frame.n)) return
    host.channels.leave(conn, channelOf(frame.n, frame.id))
    host.tap(() => ({ type: 'crdt.close', connId: conn.id, n: frame.n, id: frame.id }))
  }

  // A CRDT delta/delete arriving on a d: channel from the adapter: forward raw to local subscribers, and — for
  // a relay backend that didn't originate it — apply the delta locally so this node converges. Remote deltas
  // were already validated at their originating node (Q3), so the local apply trusts them (no-op validate).
  function onRelay(channel: string, payload: string | Uint8Array): void {
    // deliver-on-receipt: forward BEFORE consulting `own`. The loopback is how this node's own subscribers get
    // the delta — its store `onChange` deliberately publishes without delivering. `sendRaw` passes the single
    // pre-encoded buffer through to N conns.
    const set = host.channels.membersOf(channel)
    if (set) for (const conn of set) conn.sendRaw(payload)
    const msg = host.cluster.receive(payload)
    if (!msg) return
    if (msg.own) return // our own publish looped back; already applied locally (but forwarded above)
    if (!store || store.clustering !== 'relay') return
    const frame = msg.data as CDChangeFrame | CDDeleteFrame
    const def = defOf(frame.n)
    if (!def) return
    if (frame.t === 'cddel') {
      try {
        void store.delete(frame.n, frame.id)
      } catch {
        // absent — nothing to delete
      }
      return
    }
    relaying = true
    try {
      void store.apply({ n: frame.n, id: frame.id, update: frame.u as string, origin: frame.o }, def.crdt, () => {})
    } catch {
      // doc not present on this node yet (creates are node-local) — drop; it catches up on next open
    } finally {
      relaying = false
    }
  }

  // Server-authoritative create + reactive co-writer (Q10). Policy-free.
  function handle(name: string): ServerCrdtCollectionHandle {
    if (!store) throw new SuperLineError('NOT_FOUND', 'No CRDT collection backend configured')
    const def = defOf(name)!
    return {
      async create(id, data) {
        const v = await validate(def.schema, data)
        await store.create(name, id, v, def.crdt)
      },
      open(id, o) {
        return store.open(name, id, { ...o, doc: def.crdt })
      },
      async read(id) {
        const state = await store.read(name, id)
        if (state === undefined) return undefined
        const r = store.open(name, id, { doc: def.crdt })
        const s = r.getSnapshot()
        r.close()
        return s
      },
      async delete(id) {
        await store.delete(name, id)
        // relay backends fan the delete over the adapter (emit at this origin); self backends fan it via
        // onDelete on every node (which already emits crdt.delete) — so only the relay branch taps here.
        if (store.clustering !== 'self') {
          host.tap(() => ({ type: 'crdt.delete', n: name, id }))
          host.cluster.broadcast(channelOf(name, id), { t: 'cddel', n: name, id } satisfies Omit<CDDeleteFrame, 'nd'>)
        }
      },
      list(o) {
        return Promise.resolve(store.list(name, o))
      },
    }
  }

  // The store's onChange is the single fan-out source. Emit `crdt.change` once at the origin node (self: every
  // node's replica; relay: only where the delta wasn't relayed in), before per-conn delivery.
  if (store) {
    const isSelf = store.clustering === 'self'
    store.onChange((change) => {
      const channel = channelOf(change.n, change.id)
      if (isSelf) {
        // self: the central backend feeds every node's replica, so each delivers to its own local subscribers.
        host.tap(() => ({
          type: 'crdt.change',
          n: change.n,
          id: change.id,
          origin: change.origin,
          deltaBytes: deltaBytes(change.update),
        }))
        const set = host.channels.membersOf(channel)
        if (!set) return
        const payload = host.encode({ t: 'cdchg', n: change.n, id: change.id, u: change.update, o: change.origin })
        for (const conn of set) conn.sendRaw(payload)
        return
      }
      if (relaying) return
      host.tap(() => ({
        type: 'crdt.change',
        n: change.n,
        id: change.id,
        origin: change.origin,
        deltaBytes: deltaBytes(change.update),
      }))
      // relay: publish only. The loopback (onRelay) is what delivers to this node's own subscribers.
      host.cluster.broadcast(channel, {
        t: 'cdchg',
        n: change.n,
        id: change.id,
        u: change.update,
        o: change.origin,
      } satisfies Omit<CDChangeFrame, 'nd'>)
    })
    if (isSelf)
      store.onDelete?.((n, id) => {
        host.tap(() => ({ type: 'crdt.delete', n, id }))
        const set = host.channels.membersOf(channelOf(n, id))
        if (!set) return
        const payload = host.encode({ t: 'cddel', n, id })
        for (const conn of set) conn.sendRaw(payload)
      })
  }

  return { onOpen, onWrite, onClose, onRelay, handle }
}
