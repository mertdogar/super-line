export type SocketErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'VALIDATION'
  | 'DISCONNECTED'
  | 'INTERNAL'

// allow custom string codes while keeping autocomplete for the known set
export type ErrorCode = SocketErrorCode | (string & {})

export class SocketError<Data = unknown> extends Error {
  readonly code: ErrorCode
  readonly data?: Data

  constructor(code: ErrorCode, message?: string, data?: Data) {
    super(message ?? code)
    this.name = 'SocketError'
    this.code = code
    this.data = data
  }
}
