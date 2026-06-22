// Frames are opaque `string | Uint8Array`; base64 carries both safely over an SSE `data:` line or a JSON body.
const hasBuffer = typeof Buffer !== 'undefined'

export function encodeFrame(frame: string | Uint8Array): string {
  if (hasBuffer) return (typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame)).toString('base64')
  const bytes = typeof frame === 'string' ? new TextEncoder().encode(frame) : frame
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function decodeFrame(b64: string): Uint8Array {
  if (hasBuffer) return new Uint8Array(Buffer.from(b64, 'base64'))
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
