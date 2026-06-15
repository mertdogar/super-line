export { SocketError } from './errors.js'
export type { SocketErrorCode, ErrorCode } from './errors.js'

export { jsonSerializer } from './serializer.js'
export type { Serializer } from './serializer.js'

export type { Adapter } from './adapter.js'

export { defineContract, validate, validateSync } from './contract.js'
export type {
  Contract,
  Directional,
  RequestDef,
  ServerMessageDef,
  Schema,
  InferIn,
  InferOut,
  RoleOf,
  Requests,
  ServerMessages,
  Events,
  Topics,
  ServerEvents,
} from './contract.js'

export { PROTOCOL } from './wire.js'
export type {
  Frame,
  ClientFrame,
  ServerFrame,
  ReqFrame,
  SubFrame,
  UnsubFrame,
  ResFrame,
  ErrFrame,
  EvtFrame,
  PubFrame,
} from './wire.js'
