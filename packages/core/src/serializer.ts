/**
 * Wire encoder/decoder. The server and client **must** use the same one.
 * Swap in `superjson`/msgpack to carry richer types than JSON.
 */
export interface Serializer {
  /** Encode a frame for the wire. */
  encode(value: unknown): string | Uint8Array
  /** Decode a wire frame back to a value. */
  decode(data: string | Uint8Array): unknown
}

const decoder = new TextDecoder()

/** The default serializer (`JSON`). Note: turns `Date` into a string — see the serialization guide. */
export const jsonSerializer: Serializer = {
  encode: (value) => JSON.stringify(value),
  decode: (data) => JSON.parse(typeof data === 'string' ? data : decoder.decode(data)),
}
