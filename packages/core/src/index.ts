export { VERSION } from './version.js'

export { SuperLineError } from './errors.js'
export type { SuperLineErrorCode, ErrorCode } from './errors.js'

export { jsonSerializer } from './serializer.js'
export type { Serializer } from './serializer.js'

export type { Adapter, PresenceStore, ConnDescriptor, NodeStat } from './adapter.js'

export { defineContract, defineContractPlugin, defineSurface, mergeSurfaces, validate, validateSync, isCrdtCollection } from './contract.js'
export type {
  Contract,
  ContractFragment,
  ContractPlugin,
  ResolveContract,
  Directional,
  RoleBlock,
  CollectionDef,
  LwwCollectionDef,
  CrdtCollectionDef,
  DocOptions,
  CollectionsOf,
  CollectionName,
  CrdtCollectionName,
  LwwCollectionName,
  CollectionRow,
  CollectionRowInput,
  RowOf,
  RowInputOf,
  DocOf,
  DataOf,
  AnyData,
  EnvOf,
  AnyEnv,
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
  InspectedContribution,
  InspectedPlugin,
  NodeView,
  ConnView,
  InspectorEvent,
  InspectorEnvelope,
  MessageError,
  TapEvent,
  CollectionInfo,
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
  EnvFrame,
  PubFrame,
  SReqFrame,
  SResFrame,
  SErrFrame,
  CSubFrame,
  CUnsubFrame,
  RowOp,
  CBatchFrame,
  CChangeFrame,
  CDOpenFrame,
  CDWriteFrame,
  CDCloseFrame,
  CDChangeFrame,
  CDDeleteFrame,
  PingFrame,
  PongFrame,
} from './wire.js'

export type { StoreChange, ResourceReplica } from './store.js'

export type {
  CollectionStore,
  RelayCollectionStore,
  SelfCollectionStore,
  ResolvedRowOp,
  RowChange,
  RowTimestamps,
} from './collections.js'
export { withRowMeta, ROW_CREATED_AT, ROW_UPDATED_AT } from './collections.js'
export { planColumns, DEGENERATE_DATA_COLUMN } from './column-plan.js'
export type { ColumnKind, ColumnSpec, ColumnPlan } from './column-plan.js'
export type { CrdtCollectionStore, DocChange, DocSummary, DocListOpts, CrdtServerReplica, CrdtCollectionClient } from './crdt-collections.js'

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
