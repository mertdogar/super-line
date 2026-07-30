// Browser shim for the Node `crypto` builtin, aliased in for `crypto`/`node:crypto`
// (see .vitepress/config.ts). The in-page demos run REAL super-line servers, and the
// packages they load touch this much of Node crypto:
//   - @super-line/server + plugin-chat: randomUUID
//   - @super-line/plugin-auth: scrypt (password hashing), createHash('sha256') (token
//     hashes), randomBytes (salts/tokens), timingSafeEqual, hkdfSync (sealed tokens),
//     plus the global `Buffer` for hex decoding.
// Everything is backed by WebCrypto + @noble/hashes (audited, pure JS), so the auth
// tutorial's in-tab sign-up runs the plugin's actual scrypt path — not a mock.
import { scryptAsync, type ScryptOpts } from '@noble/hashes/scrypt.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'

const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const toBase64Url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The slice of Node's `Buffer` the loaded packages actually use: hex/base64url codecs. */
class SlBuffer extends Uint8Array {
  override toString(enc: 'hex' | 'base64url' | 'utf8' = 'utf8'): string {
    if (enc === 'hex') return toHex(this)
    if (enc === 'base64url') return toBase64Url(this)
    return new TextDecoder().decode(this)
  }
}
const wrap = (bytes: Uint8Array): SlBuffer => new SlBuffer(bytes.buffer, bytes.byteOffset, bytes.byteLength)
// Node-style Buffer.from — a different signature than Uint8Array.from, assigned to shadow it.
;(SlBuffer as { from: unknown }).from = (input: string | ArrayLike<number>, enc?: string): SlBuffer => {
  if (typeof input === 'string') return wrap(enc === 'hex' ? fromHex(input) : encoder.encode(input))
  return wrap(Uint8Array.from(input))
}
// plugin-auth references the global (`Buffer.from(saltHex, 'hex')`); provide it if absent.
const g = globalThis as { Buffer?: unknown }
if (!g.Buffer) g.Buffer = SlBuffer

/** lib0 (via Yjs) imports `webcrypto` for `subtle`/`getRandomValues` — the browser global IS WebCrypto. */
export const webcrypto: Crypto = globalThis.crypto

export const randomUUID = (): string => globalThis.crypto.randomUUID()

export const randomBytes = (size: number): SlBuffer =>
  wrap(globalThis.crypto.getRandomValues(new Uint8Array(size)))

/** Only sha256 — the one algorithm the loaded packages request. */
export const createHash = (algorithm: string) => {
  if (algorithm !== 'sha256') throw new Error(`crypto shim: unsupported hash '${algorithm}'`)
  const hash = sha256.create()
  const api = {
    update(data: string | Uint8Array) {
      hash.update(typeof data === 'string' ? encoder.encode(data) : data)
      return api
    },
    digest(enc?: 'hex') {
      const out = wrap(hash.digest())
      return enc === 'hex' ? out.toString('hex') : out
    },
  }
  return api
}

/** Node's callback-style scrypt (the options overload plugin-auth wraps). */
export const scrypt = (
  password: string | Uint8Array,
  salt: string | Uint8Array,
  keylen: number,
  options: { N?: number; r?: number; p?: number; maxmem?: number },
  callback: (err: Error | null, derivedKey?: SlBuffer) => void,
): void => {
  const opts: ScryptOpts = { N: options.N ?? 16_384, r: options.r ?? 8, p: options.p ?? 1, dkLen: keylen }
  scryptAsync(password, salt, opts).then(
    (derived) => callback(null, wrap(derived)),
    (err: Error) => callback(err),
  )
}

export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) throw new Error('crypto shim: timingSafeEqual length mismatch')
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Node returns an ArrayBuffer here; callers wrap it in `new Uint8Array(...)`, which accepts ours too. */
export const hkdfSync = (
  digest: string,
  ikm: string | Uint8Array,
  salt: string | Uint8Array,
  info: string | Uint8Array,
  keylen: number,
): Uint8Array => {
  if (digest !== 'sha256') throw new Error(`crypto shim: unsupported hkdf digest '${digest}'`)
  const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? encoder.encode(v) : v)
  return hkdf(sha256, bytes(ikm), bytes(salt), bytes(info), keylen)
}

export default { webcrypto, randomUUID, randomBytes, createHash, scrypt, timingSafeEqual, hkdfSync }
