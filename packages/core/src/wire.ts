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
export type ClientFrame = ReqFrame | SubFrame | UnsubFrame | SResFrame | SErrFrame

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
}
// a server→client request the client must answer (with SResFrame/SErrFrame)
export interface SReqFrame {
  t: 'sreq'
  i: number // correlation id
  m: string // request name
  d: unknown // input
}
export type ServerFrame = ResFrame | ErrFrame | EvtFrame | PubFrame | SReqFrame

export type Frame = ClientFrame | ServerFrame
