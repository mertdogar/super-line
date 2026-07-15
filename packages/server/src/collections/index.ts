import { isCrdtCollection, SuperLineError, type CBatchFrame, type CDCloseFrame, type CDOpenFrame, type CDWriteFrame, type CSubFrame, type CUnsubFrame } from '@super-line/core'
import { createCrdtCollections, CDOC } from './crdt.js'
import { createRowCollections, COLL_CHANNEL, SERVER_ORIGIN } from './rows.js'
import type { CollectionConn, CollectionHost, CollectionRuntimeConfig } from './types.js'

export { CDOC } from './crdt.js'
export { COLL_CHANNEL, SERVER_ORIGIN } from './rows.js'
export type {
  CollectionConn,
  CollectionHost,
  CollectionPolicy,
  CollectionRuntimeConfig,
  CrdtCollectionPolicy,
  ServerCollectionHandle,
  ServerCrdtCollectionHandle,
  WriteOp,
} from './types.js'

/** One collection's shape as the inspector sees it (CRDT docs surface with a synthetic `id` key). */
export interface CollectionInfoLite {
  name: string
  key: string
  references: Record<string, string>
}

/**
 * The **Collection runtime**: the server-side authority for contract-declared Collections, spanning both
 * consistency models (CONTEXT.md). One Collection concept with mode-specific behaviour — not a merger of the
 * two persistence seams, which stay separate backends by construction.
 *
 * Everything a caller must know is here: the server hands it frames off the wire, relayed payloads off the
 * Adapter, and a connection's departure; it hands back the server-authoritative handle behind
 * `srv.collection(n)` and the shapes the inspector reports. It never reaches back into the server.
 */
export interface CollectionRuntime {
  /** `csub` — subscribe to a row collection; replies with the policy-filtered initial snapshot. */
  onSub(conn: CollectionConn, frame: CSubFrame): Promise<void>
  /** `cuns` — drop one row subscription. */
  onUnsub(conn: CollectionConn, frame: CUnsubFrame): void
  /** `cbat` — an atomic row batch: validated, policy-guarded, applied, fanned out, relayed. */
  onBatch(conn: CollectionConn, frame: CBatchFrame): Promise<void>
  /** `cdopen` — open a CRDT document (server-authoritative creation means a missing doc is NOT_FOUND). */
  onCrdtOpen(conn: CollectionConn, frame: CDOpenFrame): Promise<void>
  /** `cdwr` — a CRDT delta: policy-guarded, then validate-before-commit at this ingress node. */
  onCrdtWrite(conn: CollectionConn, frame: CDWriteFrame): Promise<void>
  /** `cdclose` — leave a document's fan-out channel. */
  onCrdtClose(conn: CollectionConn, frame: CDCloseFrame): void
  /** A relayed row batch off {@link COLL_CHANNEL}. */
  onRelay(payload: string | Uint8Array): void
  /** A relayed CRDT delta/delete off a `d:<n>:<id>` channel. */
  onCrdtRelay(channel: string, payload: string | Uint8Array): void
  /** Forget a departing connection's subscriptions (its channel memberships are the host's business). */
  detach(conn: CollectionConn): void
  /** The handle behind `srv.collection(n)` — row or CRDT, chosen by the contract. Throws if undeclared. */
  handle(name: string): unknown
  /** Every declared collection's shape, for the inspector. */
  infos(): CollectionInfoLite[]
  /** True when a relay row backend needs this node subscribed to {@link COLL_CHANNEL}. */
  readonly relaysRows: boolean
}

/**
 * Build the runtime. The two families share exactly three things — the contract's `defs`, the `policies` map,
 * and the `srv.collection(n)` dispatch below — which is why they live behind one interface rather than two:
 * split the seam between them and all three straddle it.
 */
export function createCollectionRuntime(config: CollectionRuntimeConfig, host: CollectionHost): CollectionRuntime {
  const rows = createRowCollections(config, host)
  const crdt = createCrdtCollections(config, host)

  return {
    onSub: rows.onSub,
    onUnsub: rows.onUnsub,
    onBatch: rows.onBatch,
    onRelay: rows.onRelay,
    detach: rows.detach,
    onCrdtOpen: crdt.onOpen,
    onCrdtWrite: crdt.onWrite,
    onCrdtClose: crdt.onClose,
    onCrdtRelay: crdt.onRelay,
    relaysRows: rows.isRelay,

    handle(name) {
      const def = config.defs[name]
      if (!def) throw new SuperLineError('NOT_FOUND', `Collection not declared: ${name}`)
      return isCrdtCollection(def) ? crdt.handle(name) : rows.handle(name)
    },

    infos: () =>
      // CRDT document collections surface with a synthetic `id` key + no references — the inspector's
      // queryCollection synthesizes doc-rows for them (they're open-by-id, not row-queryable).
      Object.entries(config.defs).map(([name, def]) =>
        isCrdtCollection(def)
          ? { name, key: 'id', references: {} }
          : { name, key: def.key, references: def.references ?? {} },
      ),
  }
}
