import { describe, expect, it } from 'vitest'
import { apiKeyToken, hashPassword, newId, randomToken, tokenHash, verifyPassword } from '../src/crypto.js'
import { createAssertions } from '../src/assertions.js'
import { inspector } from '@super-line/plugin-inspector'

// Runs INSIDE workerd (the workers lane). plugin-auth and plugin-inspector import `node:crypto`
// (scrypt with options, hkdfSync, randomBytes, createHash, timingSafeEqual) and rely on `Buffer`;
// `nodejs_compat` is documented as covering all of it. This file is the proof — no port, just the
// real functions, unchanged, under the flag.

describe('plugin crypto under nodejs_compat', () => {
  it('scrypt with {N, r, p} hashes and verifies a password, timing-safe compare included', async () => {
    const stored = await hashPassword('correct horse battery staple')
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true)
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true)
    expect(await verifyPassword('wrong', stored)).toBe(false)
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
  })

  it('a hash produced by Node 24 verifies here (same algorithm, same encoding)', async () => {
    // node -e "scrypt('hunter2', salt, 64, {N:16384,r:8,p:1}, …)" on Node 24.22.0, in the stored format
    const fromNode =
      'scrypt$16384$8$1$542ac0225ced30eee89793ca8efde814$' +
      '8862aa03032cdcc58a962f0f542783b6c7bf17e2e43488691dbc37c5e228a06edaca6e8e4d61c3862167439aaf15b25e71f1cea7900c12bfc9192e50e04e0d02'
    expect(await verifyPassword('hunter2', fromNode)).toBe(true)
    expect(await verifyPassword('hunter3', fromNode)).toBe(false)
  })

  it('randomBytes/randomUUID/createHash produce the documented token shapes', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 bytes base64url
    expect(apiKeyToken()).toMatch(/^slp_[A-Za-z0-9_-]{43}$/)
    expect(newId()).toMatch(/^[0-9a-f-]{36}$/)
    expect(tokenHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') // sha256('abc'), hex
    expect(Buffer.from('ff00', 'hex').toString('base64url')).toBe('_wA')
  })

  it('hkdfSync + jose: signed and sealed assertions round-trip', async () => {
    const assertions = createAssertions({ secret: 's3cret-' + 'x'.repeat(32) })!
    const signed = await assertions.mintSigned('u1', { roles: ['user'], claims: { org: 'acme' } })
    expect(await assertions.verify(signed.token)).toMatchObject({ kind: 'signed', userId: 'u1', roles: ['user'], claims: { org: 'acme' } })
    const sealed = await assertions.mintSealed('u2', { sealed: { tier: 3 } })
    expect(await assertions.verify(sealed.token)).toMatchObject({ kind: 'sealed', userId: 'u2', sealed: { tier: 3 } })
    expect(await assertions.verify(signed.token.slice(0, -2) + 'xx')).toBeNull()
  })

  it('plugin-inspector loads and constructs (createHash + timingSafeEqual at module scope)', () => {
    expect(inspector({ auth: { password: 'pw' } })).toMatchObject({ name: expect.any(String) })
  })
})
