import { hkdfSync } from 'node:crypto'
import { EncryptJWT, SignJWT, importJWK, jwtDecrypt, jwtVerify, type JWK } from 'jose'
import { SuperLineError, validate, type Schema } from '@super-line/core'
import { newId } from './crypto.js'

/**
 * The two serializations of a bearer assertion (both are JWTs — RFC 7519 §1 admits either).
 *
 * - `signed` — a JWS. Its claims are **public**: anyone holding the token can base64-decode them, and anyone
 *   holding the verification key can check them. Server-minted (`authKit.tokens.mintSigned`).
 * - `sealed` — a JWE. Its claims are **opaque to its own holder**; only a party with the encryption key can
 *   read them. Server-minted only (`authKit.tokens.mintSealed`).
 */
export type AssertionKind = 'signed' | 'sealed'

/** Content-encryption key sizes, in bytes, per JWE `enc`. `dir` uses the key as the CEK, so length is exact. */
const CEK_BYTES: Record<string, number> = {
  A128GCM: 16,
  A192GCM: 24,
  A256GCM: 32,
  'A128CBC-HS256': 32,
  'A192CBC-HS384': 48,
  'A256CBC-HS512': 64,
}

const DEFAULT_SIGNED_ALG = 'HS256'
const DEFAULT_SEALED_ALG = 'dir'
const DEFAULT_SEALED_ENC = 'A256GCM'

/** A key is either a raw shared secret (symmetric only) or a JWK. */
export type AssertionKey = string | JWK

export interface AssertionOptions {
  /**
   * The shared secret, and the zero-config entry point: it signs with `HS256` and, via HKDF-SHA256, becomes the
   * `dir` content-encryption key. Supply `signed.key` / `sealed.key` instead to go asymmetric.
   */
  secret?: string
  /** Default assertion lifetime in ms. Default 15 minutes. */
  ttlMs?: number
  /** Signing config. `alg` defaults to the JWK's own `alg`, else `HS256`. */
  signed?: { alg?: string; key?: AssertionKey }
  /** Encryption config. `alg` defaults to `dir`, `enc` to `A256GCM`. */
  sealed?: { alg?: string; enc?: string; key?: AssertionKey }
  /** Validates the public `claims` bag at mint time. Any Standard Schema validator. */
  claims?: Schema
  /** Validates the `sealed` bag at mint time. Any Standard Schema validator. */
  sealedClaims?: Schema
}

/** What a verified assertion yields, before the kit enriches it with the user's current roles. */
export interface VerifiedAssertion {
  kind: AssertionKind
  userId: string
  jti: string | null
  issuedAt: number
  expiresAt: number
  /** Roles as asserted by a `signed` token. Always `[]` for `sealed` — its roles come from the user row. */
  roles: string[]
  claims: Record<string, unknown>
  sealed?: Record<string, unknown>
}

export interface Assertions {
  ttlMs: number
  mintSigned(userId: string, opts: { roles: string[]; claims?: unknown; expiresInMs?: number }): Promise<{ token: string; expiresAt: number }>
  mintSealed(userId: string, opts: { claims?: unknown; sealed?: unknown; expiresInMs?: number }): Promise<{ token: string; expiresAt: number }>
  /** Verify + decode. Returns `null` for anything unreadable — bad signature, wrong alg, expired, malformed. */
  verify(token: string): Promise<VerifiedAssertion | null>
}

/**
 * Which serialization is this compact token? A compact JWS has 3 parts (2 dots), a compact JWE has 5 (4 dots).
 * Cheaper and more honest than trying one and falling back to the other.
 */
export function assertionKind(token: string): AssertionKind | null {
  const dots = token.split('.').length - 1
  if (dots === 2) return 'signed'
  if (dots === 4) return 'sealed'
  return null
}

const isJwk = (key: AssertionKey): key is JWK => typeof key !== 'string'

/**
 * Stretch the shared secret to the exact CEK length `enc` requires. HKDF's `info` label is what keeps this key
 * cryptographically separate from the HS256 signing key, which uses the secret's raw bytes.
 */
const deriveCek = (secret: string, enc: string): Uint8Array => {
  const length = CEK_BYTES[enc]
  if (!length) throw new Error(`plugin-auth: unsupported JWE enc '${enc}'`)
  return new Uint8Array(hkdfSync('sha256', new TextEncoder().encode(secret), new Uint8Array(0), 'super-line/jwe', length))
}

/** Build the signed + sealed halves from one options block, or `undefined` when JWT is not configured. */
export function createAssertions(opts: AssertionOptions | undefined): Assertions | undefined {
  if (!opts) return undefined
  const { secret } = opts
  const ttlMs = opts.ttlMs ?? 15 * 60_000

  const signedKeyInput = opts.signed?.key ?? secret
  if (!signedKeyInput) throw new Error('plugin-auth: jwt needs a `secret` or a `signed.key`')
  const signedAlg = opts.signed?.alg ?? (isJwk(signedKeyInput) ? (signedKeyInput.alg ?? DEFAULT_SIGNED_ALG) : DEFAULT_SIGNED_ALG)

  const sealedAlg = opts.sealed?.alg ?? DEFAULT_SEALED_ALG
  const sealedEnc = opts.sealed?.enc ?? DEFAULT_SEALED_ENC
  const sealedKeyInput = opts.sealed?.key
  if (sealedAlg !== DEFAULT_SEALED_ALG && !sealedKeyInput)
    throw new Error(`plugin-auth: jwt.sealed.alg '${sealedAlg}' needs an explicit jwt.sealed.key`)
  if (sealedAlg === DEFAULT_SEALED_ALG && !sealedKeyInput && !secret)
    throw new Error('plugin-auth: jwt needs a `secret` or a `sealed.key`')

  // Keys are imported once, lazily: importJWK is async, and a symmetric secret needs no import at all.
  let signingKey: Promise<Uint8Array | CryptoKey> | undefined
  const signKey = () =>
    (signingKey ??= isJwk(signedKeyInput)
      ? (importJWK(signedKeyInput, signedAlg) as Promise<CryptoKey>)
      : Promise.resolve(new TextEncoder().encode(signedKeyInput)))

  let encryptionKey: Promise<Uint8Array | CryptoKey> | undefined
  const encKey = () =>
    (encryptionKey ??= sealedKeyInput
      ? isJwk(sealedKeyInput)
        ? (importJWK(sealedKeyInput, sealedAlg) as Promise<CryptoKey>)
        : Promise.resolve(deriveCek(sealedKeyInput, sealedEnc))
      : Promise.resolve(deriveCek(secret!, sealedEnc)))

  /**
   * Run a bag through its Standard Schema, if the host declared one. `undefined` stays `undefined` so an absent
   * payload is omitted from the token entirely rather than minted as `{}` — which keeps verification symmetric:
   * a token with no claims is never judged against a schema that would demand fields it was never given.
   */
  const check = async (schema: Schema | undefined, value: unknown, label: string): Promise<Record<string, unknown> | undefined> => {
    if (value === undefined || !schema) return value as Record<string, unknown> | undefined
    try {
      return (await validate(schema, value)) as Record<string, unknown>
    } catch (error) {
      throw new SuperLineError('VALIDATION', `${label} failed validation`, (error as SuperLineError).data)
    }
  }

  const stamp = (expiresInMs: number | undefined) => {
    const now = Date.now()
    return { now, expiresAt: now + (expiresInMs ?? ttlMs), jti: newId() }
  }

  return {
    ttlMs,

    mintSigned: async (userId, { roles, claims, expiresInMs }) => {
      const bag = await check(opts.claims, claims, 'jwt claims')
      const { now, expiresAt, jti } = stamp(expiresInMs)
      const token = await new SignJWT({ roles, ...(bag === undefined ? {} : { claims: bag }) })
        .setProtectedHeader({ alg: signedAlg })
        .setSubject(userId)
        .setJti(jti)
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor(expiresAt / 1000))
        .sign(await signKey())
      return { token, expiresAt }
    },

    mintSealed: async (userId, { claims, sealed, expiresInMs }) => {
      const [publicBag, sealedBag] = await Promise.all([
        check(opts.claims, claims, 'jwt claims'),
        check(opts.sealedClaims, sealed, 'jwt sealed claims'),
      ])
      const { now, expiresAt, jti } = stamp(expiresInMs)
      const token = await new EncryptJWT({
        ...(publicBag === undefined ? {} : { claims: publicBag }),
        ...(sealedBag === undefined ? {} : { sealed: sealedBag }),
      })
        .setProtectedHeader({ alg: sealedAlg, enc: sealedEnc })
        .setSubject(userId)
        .setJti(jti)
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor(expiresAt / 1000))
        .encrypt(await encKey())
      return { token, expiresAt }
    },

    verify: async (token) => {
      const kind = assertionKind(token)
      if (!kind) return null
      try {
        // The accepted algorithms are ALWAYS the configured ones. Never let the token's own header pick the
        // key — that is the alg-confusion attack (flip RS256→HS256 and sign with the public key).
        const { payload } =
          kind === 'signed'
            ? await jwtVerify(token, await signKey(), { algorithms: [signedAlg] })
            : await jwtDecrypt(token, await encKey(), {
                keyManagementAlgorithms: [sealedAlg],
                contentEncryptionAlgorithms: [sealedEnc],
              })
        if (!payload.sub || typeof payload.exp !== 'number') return null
        const bag = (key: string): Record<string, unknown> | undefined => {
          const value = payload[key]
          return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
        }
        // Re-validate against the CURRENT schemas. Tampering is already impossible (a JWS is signed, a JWE is
        // AEAD-authenticated), so this catches exactly one thing: a token minted before a schema change. Failing
        // here returns null, which degrades the connection to guest rather than handing a handler a stale shape.
        const claims = await check(opts.claims, bag('claims'), 'jwt claims')
        const sealed = kind === 'sealed' ? await check(opts.sealedClaims, bag('sealed'), 'jwt sealed claims') : undefined
        return {
          kind,
          userId: payload.sub,
          jti: typeof payload.jti === 'string' ? payload.jti : null,
          issuedAt: typeof payload.iat === 'number' ? payload.iat * 1000 : 0,
          expiresAt: payload.exp * 1000,
          roles: kind === 'signed' && Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
          claims: claims ?? {},
          ...(kind === 'sealed' ? { sealed: sealed ?? {} } : {}),
        }
      } catch {
        return null // bad signature, wrong alg, expired, undecryptable → unauthenticated
      }
    },
  }
}
