/**
 * The wire protocol below is an implementation detail — you rarely touch frames
 * directly. It's exported for adapters, custom transports, and tooling.
 */

import type { CollectionQuery } from './query.js'

/** Protocol version string, negotiated via the WebSocket subprotocol at upgrade. */
export const PROTOCOL = 'superline.v1'

// Client -> Server
export interface ReqFrame {
  t: 'req'
  i: number // correlation id
  m: string // message (method) name
  d: unknown // input
}
export interface SubFrame {
  t: 'sub'
  i: number // correlation id (acked via res/err)
  c: string // channel
}
export interface UnsubFrame {
  t: 'unsub'
  c: string
}
// reply to a server→client request (server initiates, client answers)
export interface SResFrame {
  t: 'sres'
  i: number // correlation id from the SReqFrame
  d: unknown // output
}
export interface SErrFrame {
  t: 'serr'
  i: number
  code: string
  m: string
  d?: unknown
}
// App-level liveness. The server sends `ping`; the recipient answers `pong`. These replace
// WebSocket protocol pings so every transport (SSE, libp2p, …) shares one heartbeat.
export interface PingFrame {
  t: 'ping'
}
export interface PongFrame {
  t: 'pong'
}
// Store frames (off-contract, reserved). `n` = store name, `id` = Resource id, `u` = opaque update, `o` = writer origin.
// Open + read are acked via res (snapshot) / err; write via res (ok) / err (e.g. FORBIDDEN).
export interface SOpenFrame {
  t: 'sopen'
  i: number // correlation id (acked via res with the catch-up snapshot / err)
  n: string // store name
  id: string // resource id
}
export interface SCloseFrame {
  t: 'sclose'
  n: string
  id: string
}
export interface SWriteFrame {
  t: 'swr'
  i: number // correlation id (acked via res / err)
  n: string
  id: string
  u: unknown // opaque update (CRDT delta | full JSON value)
  o: string // writer origin (echo-break)
}
export interface SReadFrame {
  t: 'srd'
  i: number // correlation id (acked via res with the snapshot / err)
  n: string
  id: string
}
// Collection frames (on-contract typed rows; see ADR-0006). A subscribe carries a query IR; the initial
// snapshot rides the `res` ack. `s` is a client-assigned subscription id (durable routing handle, distinct
// from the per-request correlation `i`). Live row changes push via `cchg`; writes go up as an atomic `cbat`.
export interface CSubFrame {
  t: 'csub'
  i: number // correlation id — acked via res (initial snapshot: row[]) / err
  n: string // collection name
  s: number // client-assigned subscription id
  q: CollectionQuery // filter + orderBy + limit/offset (orderBy/limit shape the snapshot only)
}
export interface CUnsubFrame {
  t: 'cuns'
  n: string
  s: number // subscription id from the CSubFrame
}
/** One row mutation within a {@link CBatchFrame}. `d` is the FULL row (validated against the collection schema); delete carries none. */
export type RowOp =
  | { op: 'insert'; n: string; id: string; d: unknown }
  | { op: 'update'; n: string; id: string; d: unknown }
  | { op: 'delete'; n: string; id: string }
export interface CBatchFrame {
  t: 'cbat'
  i: number // correlation id — acked via res (ok) / err. The whole batch applies atomically on the handling node.
  ops: RowOp[] // may span collections; applied in order, all-or-nothing
}
// CRDT document collection frames (ADR-0007). A CRDT collection is opened by id (whole-doc merge, not
// queryable); these mirror the store frames 1:1 but ride the collection API. `cdopen` catches up with full
// Yjs state on the `res` ack; `cdwr` carries an opaque base64 delta gated by validate-before-commit; live
// deltas push via `cdchg`, deletions via `cddel`.
export interface CDOpenFrame {
  t: 'cdopen'
  i: number // correlation id — acked via res (full Yjs state) / err
  n: string // collection name
  id: string // document id
}
export interface CDWriteFrame {
  t: 'cdwr'
  i: number // correlation id — acked via res (null) / err (validation → client resync)
  n: string
  id: string
  u: unknown // opaque base64 Yjs delta
  o: string // writer origin (echo-break)
}
export interface CDCloseFrame {
  t: 'cdclose'
  n: string
  id: string
}
export type ClientFrame =
  | ReqFrame
  | SubFrame
  | UnsubFrame
  | SResFrame
  | SErrFrame
  | SOpenFrame
  | SCloseFrame
  | SWriteFrame
  | SReadFrame
  | CSubFrame
  | CUnsubFrame
  | CBatchFrame
  | CDOpenFrame
  | CDWriteFrame
  | CDCloseFrame
  | PingFrame
  | PongFrame

// Server -> Client
export interface ResFrame {
  t: 'res'
  i: number
  d: unknown // output
}
export interface ErrFrame {
  t: 'err'
  i?: number // present => failed request/sub; absent => connection-level error
  code: string
  m: string // message
  d?: unknown // structured error data
}
export interface EvtFrame {
  t: 'evt'
  e: string // event name
  d: unknown
}
export interface PubFrame {
  t: 'pub'
  c: string // channel
  d: unknown
  i?: string // origin node id; stamped for server-side bus dedup, ignored by clients
}
// a server→client request the client must answer (with SResFrame/SErrFrame)
export interface SReqFrame {
  t: 'sreq'
  i: number // correlation id
  m: string // request name
  d: unknown // input
}
// a server→client Store Change push (fan-out of an applied mutation on a Resource the client subscribes to)
export interface SChangeFrame {
  t: 'sch'
  n: string // store name
  id: string // resource id
  u: unknown // opaque update
  o: string // writer origin (echo-break)
  nd?: string // origin NODE id; stamped for cross-node relay dedup, ignored by clients
}
// a server→client Store delete push (fan-out of a delete on a Resource the client subscribes to)
export interface SDeleteFrame {
  t: 'sdel'
  n: string // store name
  id: string // resource id
  nd?: string // origin NODE id; stamped for cross-node relay dedup, ignored by clients
}
// a server→client Collection row change. The server sends it to a connection when the row (post-op for
// insert/update, pre-op for delete) crosses that connection's effective visibility (policy read-filter ∧
// the OR of its subscription filters on `n`). The CLIENT then re-filters per subscription: a provided `d`
// upserts into subs it matches and removes from subs it no longer matches (handles "left the filter"); a
// delete (no `d`) removes the id from every sub on `n`. Keeps the server free of per-subscription state.
export interface CChangeFrame {
  t: 'cchg'
  n: string // collection name
  k: 'insert' | 'update' | 'delete' // op kind (fidelity for inspector/attribution; client routes off `d` presence + filter match)
  id: string
  d?: unknown // the row for insert/update; absent for delete
  nd?: string // origin NODE id; stamped for cross-node relay dedup, ignored by clients
}
// a server→client CRDT document change (fan-out of an applied delta on a doc the client has open) — the
// collection-family mirror of `sch`.
export interface CDChangeFrame {
  t: 'cdchg'
  n: string // collection name
  id: string // document id
  u: unknown // opaque base64 Yjs delta
  o: string // writer origin (echo-break)
  nd?: string // origin NODE id; stamped for cross-node relay dedup, ignored by clients
}
// a server→client CRDT document delete (fan-out) — the collection-family mirror of `sdel`.
export interface CDDeleteFrame {
  t: 'cddel'
  n: string
  id: string
  nd?: string
}
export type ServerFrame =
  | ResFrame
  | ErrFrame
  | EvtFrame
  | PubFrame
  | SReqFrame
  | SChangeFrame
  | SDeleteFrame
  | CChangeFrame
  | CDChangeFrame
  | CDDeleteFrame
  | PingFrame
  | PongFrame

export type Frame = ClientFrame | ServerFrame
