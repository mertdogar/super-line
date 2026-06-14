export interface Serializer {
  encode(value: unknown): string | Uint8Array
  decode(data: string | Uint8Array): unknown
}

const decoder = new TextDecoder()

export const jsonSerializer: Serializer = {
  encode: (value) => JSON.stringify(value),
  decode: (data) => JSON.parse(typeof data === 'string' ? data : decoder.decode(data)),
}
