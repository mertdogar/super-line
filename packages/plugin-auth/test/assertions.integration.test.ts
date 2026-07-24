import { afterEach, describe, expect, it } from 'vitest'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract, type AuthContext } from '@super-line/plugin-auth'
import { auth, type AssertionOptions } from '@super-line/plugin-auth/server'
import { createHarness } from '../../server/test/harness.js'

// `peek` echoes the whole auth context back, so a test can assert exactly what a handler sees.
const app = defineContract({
  roles: {
    user: { clientToServer: { peek: { input: z.void(), output: z.record(z.string(), z.unknown()) } } },
    admin: { clientToServer: { adminOnly: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract()],
})

const SECRET = 'test-only-shared-secret'

const h = createHarness()
afterEach(() => h.dispose())

async function boot(jwt: AssertionOptions = { secret: SECRET }) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'], jwt })
  const { srv, url } = await h.server(app, {
    nodeKey: 'assertions-test',
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin],
  })
  srv.implement({
    user: { peek: async (_i: unknown, ctx: AuthContext) => ({ ...ctx }) },
    admin: { adminOnly: async () => ({ ok: true }) },
  } as never)
  return { srv, url, authKit }
}

/** Sign up a throwaway user and return their id (plus the access token, for connections that need one). */
async function signUp(url: string, email = 'ada@x.com') {
  const guest = h.client(app, { url, role: 'guest' })
  const identity = await guest.signUp({ email, password: 'passpass', displayName: 'Ada' })
  guest.close()
  return identity
}

describe('plugin-auth — sealed assertions', () => {
  it('delivers both payloads to the server and neither the sealed one to its holder', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)

    const { token } = await authKit.tokens.mintSealed(userId, {
      claims: { workspace: 'acme' },
      sealed: { upstreamKey: 'sk-live-do-not-leak' },
    })

    // the holder cannot read it: a JWE has 5 parts and its payload segment is ciphertext, not JSON
    expect(token.split('.')).toHaveLength(5)
    expect(() => decodeJwt(token)).toThrow()
    expect(token).not.toContain('sk-live-do-not-leak')
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'dir', enc: 'A256GCM' })

    const client = h.client(app, { url, role: 'user', params: { jwt: token } })
    expect(await client.peek()).toMatchObject({
      userId,
      authMethod: 'jwt-sealed',
      claims: { workspace: 'acme' },
      sealed: { upstreamKey: 'sk-live-do-not-leak' },
    })
    client.close()
  })

  it('resolves a sealed assertion’s roles from the user row, not from the token', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)
    // minted while Ada is only a `user` — the token itself carries no roles at all
    const { token } = await authKit.tokens.mintSealed(userId)
    expect(await authKit.tokens.verify(token)).toMatchObject({ roles: ['user'] })

    await authKit.users.setRoles(userId, ['user', 'admin'])
    // the very same token now reports the new grant: nothing was baked in at mint
    expect(await authKit.tokens.verify(token)).toMatchObject({ roles: ['user', 'admin'] })

    // the SAME token now opens an admin connection: the grant came from the row on this connect
    const promoted = h.client(app, { url, role: 'admin', params: { jwt: token } })
    expect(await promoted.adminOnly()).toEqual({ ok: true })
    promoted.close()
  })

  it('refuses to mint for a deactivated user, and stops verifying their live tokens', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)
    const { token } = await authKit.tokens.mintSealed(userId, { sealed: { tier: 'gold' } })
    expect(await authKit.tokens.verify(token)).toMatchObject({ kind: 'sealed', userId, roles: ['user'] })

    await authKit.users.deactivate(userId)
    expect(await authKit.tokens.verify(token)).toBeNull()
    await expect(authKit.tokens.mintSealed(userId)).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('honours expiresInMs and reports the deadline', async () => {
    const { url, authKit } = await boot({ secret: SECRET, ttlMs: 60_000 })
    const { userId } = await signUp(url)
    const { token, expiresAt } = await authKit.tokens.mintSealed(userId, { expiresInMs: 5_000 })
    expect(expiresAt - Date.now()).toBeLessThan(6_000)
    expect(await authKit.tokens.verify(token)).toMatchObject({ expiresAt: Math.floor(expiresAt / 1000) * 1000 })
  })
})

describe('plugin-auth — signed assertions', () => {
  it('carries a claims bag into ctx, with no sealed half', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)

    const { token: jwt } = await authKit.tokens.mintSigned(userId, { claims: { tab: 'left' } })

    expect(jwt.split('.')).toHaveLength(3)
    expect(decodeJwt(jwt)).toMatchObject({ sub: userId, claims: { tab: 'left' } }) // public by construction

    const client = h.client(app, { url, role: 'user', params: { jwt } })
    const ctx = (await client.peek()) as unknown as AuthContext
    expect(ctx).toMatchObject({ userId, authMethod: 'jwt', claims: { tab: 'left' } })
    expect(ctx.sealed).toBeUndefined()
    client.close()
  })

  it('is mintable server-side too, taking roles from the row', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)
    await authKit.users.setRoles(userId, ['user', 'admin'])
    const { token } = await authKit.tokens.mintSigned(userId, { claims: { via: 'back-office' } })
    expect(await authKit.tokens.verify(token)).toMatchObject({
      kind: 'signed',
      userId,
      roles: ['user', 'admin'],
      claims: { via: 'back-office' },
    })
  })
})

describe('plugin-auth — assertion algorithms + schemas', () => {
  it('pins the accepted algorithm rather than trusting the token header', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)
    const { token } = await authKit.tokens.mintSigned(userId)
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'HS256' })

    // same secret, different configured alg → refused. Without pinning, an attacker choosing the alg is the
    // classic confusion attack; here the token's own header never selects anything.
    const other = await boot({ secret: SECRET, signed: { alg: 'HS384' } })
    expect(await other.authKit.tokens.verify(token)).toBeNull()
  })

  it('does not verify a token minted with a different secret', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url)
    const { token } = await authKit.tokens.mintSealed(userId, { sealed: { a: 1 } })
    const other = await boot({ secret: 'a-completely-different-secret' })
    expect(await other.authKit.tokens.verify(token)).toBeNull()
  })

  it('validates both payloads at mint time against the host schemas', async () => {
    const jwt: AssertionOptions = {
      secret: SECRET,
      claims: z.object({ workspace: z.string() }),
      sealedClaims: z.object({ tier: z.enum(['free', 'pro']) }),
    }
    const { url, authKit } = await boot(jwt)
    const { userId } = await signUp(url)

    await expect(authKit.tokens.mintSealed(userId, { claims: { workspace: 42 } })).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    await expect(
      authKit.tokens.mintSealed(userId, { claims: { workspace: 'acme' }, sealed: { tier: 'platinum' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })

    const { token } = await authKit.tokens.mintSealed(userId, {
      claims: { workspace: 'acme' },
      sealed: { tier: 'pro' },
    })
    expect(await authKit.tokens.verify(token)).toMatchObject({ claims: { workspace: 'acme' }, sealed: { tier: 'pro' } })
  })

  it('fails a drifted token closed to guest instead of handing a handler a stale shape', async () => {
    const { url, authKit } = await boot({ secret: SECRET, sealedClaims: z.object({ tier: z.string() }) })
    const { userId } = await signUp(url)
    const { token } = await authKit.tokens.mintSealed(userId, { sealed: { tier: 'pro' } })

    // a later deploy tightens the schema; the already-issued token no longer satisfies it
    const redeployed = await boot({ secret: SECRET, sealedClaims: z.object({ tier: z.enum(['free']) }) })
    expect(await redeployed.authKit.tokens.verify(token)).toBeNull()

    const client = h.client(app, { url: redeployed.url, role: 'user', params: { jwt: token } })
    expect(await client.whoami()).toBeNull() // degraded to guest, not accepted with stale claims
    client.close()
  })

  it('refuses the whole feature when jwt is not configured', async () => {
    const backend = memoryCollections()
    const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
    await expect(authKit.tokens.mintSealed('anyone')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
