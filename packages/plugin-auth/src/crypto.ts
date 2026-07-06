import { createHash, randomBytes, randomUUID, scrypt as scryptCb, type ScryptOptions, timingSafeEqual } from 'node:crypto'

// promisify picks scrypt's 3-arg overload, dropping the options form we need — wrap the options overload directly.
const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => (err ? reject(err) : resolve(derived)))
  })
// scrypt cost params (OWASP-acceptable). N*r*128 ≈ 16 MiB, under node's 32 MiB default maxmem.
const N = 16_384
const R = 8
const P = 1
const KEYLEN = 64

/** Hash a password with scrypt + a random salt. Encodes params so verification is self-describing: `scrypt$N$r$p$salt$hash` (hex). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** Verify a password against a stored `scrypt$…` hash. Timing-safe; returns false on any malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltHex, hashHex] = parts
  const salt = Buffer.from(saltHex!, 'hex')
  const expected = Buffer.from(hashHex!, 'hex')
  const derived = (await scrypt(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })) as Buffer
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** A fresh opaque token — 256 bits, base64url. The client holds this; the server only ever stores its hash. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url')
}

/** A fresh API key. The `slp_` prefix makes it recognizable in logs; the server stores only its hash. */
export function apiKeyToken(): string {
  return `slp_${randomBytes(32).toString('base64url')}`
}

/** SHA-256 (hex) of a token — the stored primary key, so a DB/inspector leak never exposes a usable token. */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A fresh random user id. */
export function newId(): string {
  return randomUUID()
}
