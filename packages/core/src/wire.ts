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
export type ClientFrame = ReqFrame | SubFrame | UnsubFrame

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
export type ServerFrame = ResFrame | ErrFrame | EvtFrame | PubFrame

export type Frame = ClientFrame | ServerFrame
