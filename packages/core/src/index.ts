export { SuperLineError } from './errors.js'
export type { SuperLineErrorCode, ErrorCode } from './errors.js'

export { jsonSerializer } from './serializer.js'
export type { Serializer } from './serializer.js'

export type { Adapter, PresenceStore, ConnDescriptor, NodeStat } from './adapter.js'

export { defineContract, defineSurface, mergeSurfaces, validate, validateSync } from './contract.js'
export type {
  Contract,
  Directional,
  RoleBlock,
  CollectionDef,
  CollectionsOf,
  CollectionName,
  CollectionRow,
  CollectionRowInput,
  RowOf,
  RowInputOf,
  DataOf,
  AnyData,
  RequestDef,
  ServerMessageDef,
  ServerRequestDef,
  ServerEntry,
  ServerRequests,
  SharedServerRequests,
  Schema,
  InferIn,
  InferOut,
  RoleOf,
  CtsOf,
  Requests,
  ServerMessages,
  Events,
  Topics,
  SharedRequests,
  RoleRequests,
  SharedEvents,
  SharedTopics,
  RoleTopics,
  ClientInput,
  ServerInput,
  Output,
  EventData,
  EmitData,
} from './contract.js'

export {
  InspectorContract,
  classifyContract,
  eventPayload,
  INSPECTOR_SUBPROTOCOL,
  INSPECTOR_ROLE,
} from './inspector.js'
export type {
  MessageFlavor,
  InspectedMessage,
  InspectedDirectional,
  InspectedContract,
  NodeView,
  ConnView,
  InspectorEvent,
  InspectorEnvelope,
  TapEvent,
  StoreInfo,
  StoreResourceView,
  SchemaConverter,
} from './inspector.js'

export { PROTOCOL } from './wire.js'

export { removeAtPath } from './store.js'
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
  SReqFrame,
  SResFrame,
  SErrFrame,
  SOpenFrame,
  SCloseFrame,
  SWriteFrame,
  SReadFrame,
  SChangeFrame,
  SDeleteFrame,
  CSubFrame,
  CUnsubFrame,
  RowOp,
  CBatchFrame,
  CChangeFrame,
  PingFrame,
  PongFrame,
} from './wire.js'

export type {
  Principal,
  Perms,
  AccessRules,
  Resource,
  StoreChange,
  ServerStore,
  ResourceSummary,
  ListOpts,
  SearchOpts,
  ClientStore,
  ResourceReplica,
  ServerReplica,
} from './store.js'

export type { CollectionStore, ResolvedRowOp, RowChange } from './collections.js'

export {
  and,
  or,
  not,
  eq,
  neq,
  lt,
  lte,
  gt,
  gte,
  isIn,
  like,
  ilike,
  andFilters,
  orFilters,
  matchesFilter,
  evalExpr,
  applyQuery,
  getField,
} from './query.js'
export type { Scalar, Expr, OrderBy, CollectionQuery } from './query.js'

export type {
  RawConn,
  Handshake,
  AuthOutcome,
  ReservedConnection,
  ServerTransport,
  ClientTransport,
} from './transport.js'
