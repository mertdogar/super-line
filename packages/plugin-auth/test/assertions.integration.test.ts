import { afterEach, describe, expect, it } from 'vitest'
import { decodeJwt, decodeProtectedHeader } from 'jose'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract, type AuthContext } from '@super-line/plugin-auth'
import { auth, type AssertionOptions } from '@super-line/plugin-auth/server'
import { authClient } from '@super-line/plugin-auth/client'
import { createHarness, tick } from '../../server/test/harness.js'

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

describe('plugin-auth — tokenParam + rejectUnauthenticated (Phase 1)', () => {
  it('authClient tokenParam routes a server-minted token under { jwt } (sealed connect)', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url, 'sj@x.com')
    const { token: sealed } = await authKit.tokens.mintSealed(userId)
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      storage: { get: () => sealed, set: () => {} },
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    // routed under { jwt } → the sealed assertion authenticates; the WRONG key ({ token }) would degrade to guest
    expect(ac.state.status).toBe('authed')
    expect(ac.state.userId).toBe(userId)
    ac.client.close()
  })

  it('default tokenParam is "token" (the access-token slot)', async () => {
    const { url } = await boot()
    const { token } = await signUp(url, 'tp@x.com')
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      storage: { get: () => token, set: () => {} },
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.status).toBe('authed') // routed under { token } (default) → access-token path authenticates
    ac.client.close()
  })

  it('rejectUnauthenticated refuses a presented-but-invalid token instead of downgrading to guest', async () => {
    const backend = memoryCollections()
    const authKit = auth({
      contract: app,
      collections: backend,
      defaultRoles: ['user'],
      jwt: { secret: SECRET },
      rejectUnauthenticated: true,
    })
    const { srv, url } = await h.server(app, {
      nodeKey: 'strict-test',
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin],
    })
    srv.implement({
      user: { peek: async (_i: unknown, ctx: AuthContext) => ({ ...ctx }) },
      admin: { adminOnly: async () => ({ ok: true }) },
    } as never)

    // a PRESENTED-but-invalid token → authenticate throws → the upgrade is refused (reconnect:false surfaces it)
    const bad = h.client(app, { url, role: 'user', params: { jwt: 'not.a.real.assertion' }, reconnect: false })
    await expect(bad.whoami()).rejects.toThrow()
    bad.close()

    // a credential-LESS connect still resolves guest
    const guest = h.client(app, { url, role: 'guest' })
    expect(await guest.whoami()).toBeNull()
    guest.close()
  })

  it('without rejectUnauthenticated (default) the same bad token degrades to guest', async () => {
    const { url } = await boot()
    const client = h.client(app, { url, role: 'user', params: { jwt: 'not.a.real.assertion' } })
    expect(await client.whoami()).toBeNull() // accepted as guest, not refused
    client.close()
  })
})

describe('plugin-auth — resolveToken + AuthState.error (Phase 2)', () => {
  it('boots guest-first and swaps to authed on a server-minted token, without persisting it', async () => {
    const { url, authKit } = await boot()
    const { userId } = await signUp(url, 'rt@x.com')
    const { token: sealed } = await authKit.tokens.mintSealed(userId)
    const setCalls: (string | null)[] = []
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      storage: { get: () => null, set: (t) => setCalls.push(t) },
      resolveToken: async () => ({ token: sealed }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.status).toBe('authed')
    expect(ac.state.userId).toBe(userId)
    expect(ac.state.error ?? null).toBeNull()
    expect(setCalls).toHaveLength(0) // the source owns re-acquisition — its token is never stashed in storage
    ac.client.close()
  })

  it('a null resolveToken result stays guest with no error', async () => {
    const { url } = await boot()
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => null,
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.status).toBe('guest')
    expect(ac.state.error ?? null).toBeNull()
    ac.client.close()
  })

  it('a rejected token surfaces state.error (whoami-null path) and drops to guest', async () => {
    const { url } = await boot() // default server: a bad token degrades to guest, whoami returns null
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => ({ token: 'not.a.real.assertion' }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.status).toBe('guest')
    expect(ac.state.error).toMatchObject({ reason: expect.any(String) })
    ac.client.close()
  })

  it('surfaces state.error (connect-throw path) when a rejectUnauthenticated server refuses the token', async () => {
    const backend = memoryCollections()
    const authKit = auth({
      contract: app,
      collections: backend,
      defaultRoles: ['user'],
      jwt: { secret: SECRET },
      rejectUnauthenticated: true,
    })
    const { srv, url } = await h.server(app, {
      nodeKey: 'strict-rt',
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin],
    })
    srv.implement({
      user: { peek: async (_i: unknown, ctx: AuthContext) => ({ ...ctx }) },
      admin: { adminOnly: async () => ({ ok: true }) },
    } as never)
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => ({ token: 'not.a.real.assertion' }),
      // reconnect:false so the refused authed upgrade surfaces at once instead of retrying forever
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params, reconnect: false }),
    })
    await ac.ready
    expect(ac.state.status).toBe('guest')
    expect(ac.state.error).toMatchObject({ reason: expect.any(String) })
    ac.client.close()
  })
})

// ADR-0020 — a session replacement never destroys a session it could not replace, and only one
// transition runs at a time. `reauthenticate()` re-consults the credential source; boot is merely its
// first consultation, so both go through one code path.
describe('plugin-auth — session replacement (ADR-0020)', () => {
  it('reauthenticate() swaps to the identity the source now yields', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'switch-a@x.com')
    const b = await signUp(url, 'switch-b@x.com')
    let mint = (await authKit.tokens.mintSealed(a.userId)).token
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => ({ token: mint }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.userId).toBe(a.userId)

    mint = (await authKit.tokens.mintSealed(b.userId)).token
    const settled = await ac.reauthenticate()
    expect(settled.status).toBe('authed')
    expect(settled.userId).toBe(b.userId)
    expect(ac.state.userId).toBe(b.userId)
    expect(ac.state.pending).toBe(false)
    // the new connection is live and answers as B
    expect(await (ac.client as unknown as { peek(): Promise<{ userId: string }> }).peek()).toMatchObject({ userId: b.userId })
    ac.client.close()
  })

  it('keeps the live session when the source throws, and surfaces the error', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'keep-a@x.com')
    const token = (await authKit.tokens.mintSealed(a.userId)).token
    let fail = false
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => {
        if (fail) throw new Error('mint route is down')
        return { token }
      },
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    const before = ac.client

    fail = true
    const settled = await ac.reauthenticate()
    expect(settled.status).toBe('authed') // NOT dropped to guest
    expect(settled.userId).toBe(a.userId)
    expect(settled.error).toMatchObject({ reason: expect.stringContaining('mint route is down') })
    expect(ac.client).toBe(before) // the incumbent connection was never closed
    expect(await (ac.client as unknown as { peek(): Promise<{ userId: string }> }).peek()).toMatchObject({ userId: a.userId })
    ac.client.close()
  })

  it('keeps the live session when the new credential is refused', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'refused-a@x.com')
    let token = (await authKit.tokens.mintSealed(a.userId)).token
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => ({ token }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    const before = ac.client

    token = 'not.a.real.assertion'
    const settled = await ac.reauthenticate()
    expect(settled.status).toBe('authed')
    expect(settled.userId).toBe(a.userId)
    expect(settled.error).toMatchObject({ reason: expect.any(String) })
    expect(ac.client).toBe(before)
    ac.client.close()
  })

  it('drops to guest when the source deliberately answers null', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'null-a@x.com')
    const token = (await authKit.tokens.mintSealed(a.userId)).token
    let signedOutUpstream = false
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => (signedOutUpstream ? null : { token }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.status).toBe('authed')

    signedOutUpstream = true
    const settled = await ac.reauthenticate()
    expect(settled.status).toBe('guest')
    expect(settled.userId).toBeNull()
    expect(settled.error ?? null).toBeNull() // a deliberate answer, not a failure
    ac.client.close()
  })

  it('reports `pending` for the duration of a transition', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'pending-a@x.com')
    const token = (await authKit.tokens.mintSealed(a.userId)).token
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => ({ token }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.pending).toBe(false)

    const seen: boolean[] = []
    const off = ac.subscribe((s) => seen.push(s.pending))
    const p = ac.reauthenticate()
    expect(ac.state.pending).toBe(true) // set synchronously, before the first await
    expect(ac.state.status).toBe('authed') // the incumbent still describes the session
    expect(ac.state.userId).toBe(a.userId)
    await p
    off()
    expect(seen).toEqual([true, false])
    ac.client.close()
  })

  it('refuses a second transition while one is in flight', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'busy-a@x.com')
    const token = (await authKit.tokens.mintSealed(a.userId)).token
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => ({ token }),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready

    const first = ac.reauthenticate()
    await expect(ac.reauthenticate()).rejects.toThrow(/in flight/i)
    await expect(ac.signOut()).rejects.toThrow(/in flight/i)
    await first
    ac.client.close()
  })

  // The shipping bug this guard fixes: boot's resolveToken used to swap unconditionally, so a slow mint
  // landing AFTER an interactive signIn silently overwrote the signed-in session with the boot token.
  it('refuses signIn while boot is still resolving, instead of letting boot clobber it later', async () => {
    const { url, authKit } = await boot()
    const a = await signUp(url, 'race-a@x.com')
    await signUp(url, 'race-b@x.com')
    const token = (await authKit.tokens.mintSealed(a.userId)).token
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      tokenParam: 'jwt',
      resolveToken: async () => {
        await gate
        return { token }
      },
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await tick()
    expect(ac.state.pending).toBe(true)
    await expect(ac.signIn({ email: 'race-b@x.com', password: 'passpass' })).rejects.toThrow(/in flight/i)

    release()
    await ac.ready
    expect(ac.state.userId).toBe(a.userId) // boot won, and said so at the time
    ac.client.close()
  })

  it('re-consults storage when there is no resolveToken (password app revalidate)', async () => {
    const { url } = await boot()
    const a = await signUp(url, 'pw-a@x.com')
    const ac = authClient<typeof app, 'user'>({
      authedRole: 'user',
      storage: { get: () => a.token, set: () => {} },
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await ac.ready
    expect(ac.state.status).toBe('authed')
    const before = ac.client

    const settled = await ac.reauthenticate()
    expect(settled.status).toBe('authed')
    expect(settled.userId).toBe(a.userId)
    expect(ac.client).not.toBe(before) // a genuine replacement, not a no-op
    ac.client.close()
  })
})
