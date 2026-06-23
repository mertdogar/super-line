/**
 * The wire protocol below is an implementation detail — you rarely touch frames
 * directly. It's exported for adapters, custom transports, and tooling.
 */

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
export type ServerFrame =
  | ResFrame
  | ErrFrame
  | EvtFrame
  | PubFrame
  | SReqFrame
  | SChangeFrame
  | PingFrame
  | PongFrame

export type Frame = ClientFrame | ServerFrame
