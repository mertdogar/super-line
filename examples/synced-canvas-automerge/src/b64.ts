// CRDT changes are binary (Uint8Array). super-line's default serializer is JSON, so we
// base64-wrap the bytes to ride a JSON transport. Isomorphic: btoa/atob are global in
// modern Node and the browser.

export function toB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}
