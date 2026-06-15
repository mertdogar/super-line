/** The built-in error codes super-line uses across the wire. */
export type SocketErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'VALIDATION'
  | 'DISCONNECTED'
  | 'INTERNAL'

/** A built-in code or any custom string (autocomplete keeps the known set). */
export type ErrorCode = SocketErrorCode | (string & {})

/**
 * The error type carried end-to-end. Throw one from a handler and the client's
 * promise rejects with the same `code` (and optional `data`). Unknown throws
 * become `INTERNAL` so server internals aren't leaked.
 */
export class SocketError<Data = unknown> extends Error {
  /** The typed error code (e.g. `'FORBIDDEN'`), available on the client. */
  readonly code: ErrorCode
  /** Optional structured data attached to the error, delivered to the client. */
  readonly data?: Data

  /**
   * @param code - a {@link SocketErrorCode} or custom string.
   * @param message - human-readable message (defaults to `code`).
   * @param data - optional structured payload delivered to the client.
   */
  constructor(code: ErrorCode, message?: string, data?: Data) {
    super(message ?? code)
    this.name = 'SocketError'
    this.code = code
    this.data = data
  }
}
