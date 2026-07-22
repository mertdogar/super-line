import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract, like } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth, type AuthServer } from '@super-line/plugin-auth/server'
import { createHarness, waitFor } from '../../server/test/harness.js'

// Same tiny app as auth.integration.test.ts: the imperative management surface (Phase 0 of
// PLAN-plugin-chat.md) is exercised against a real server so co-writes provably fan out.
const app = defineContract({
  roles: {
    user: { clientToServer: { secret: { input: z.void(), output: z.object({ me: z.string() }) } } },
    admin: { clientToServer: { adminOnly: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

async function boot(jwt?: { secret: string }, sendPasswordReset?: (args: { user: { id: string }; token: string }) => void) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'], jwt, sendPasswordReset })
  const { srv, url } = await h.server(app, {
    nodeKey: 'auth-management-test',
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin],
  })
  srv.implement({
    user: { secret: async (_i: unknown, ctx: { userId: string | null }) => ({ me: ctx.userId ?? 'anon' }) },
    admin: { adminOnly: async () => ({ ok: true }) },
  } as never)
  return { srv, url, authKit }
}

async function createUser(
  authKit: AuthServer<typeof app>,
  input: {
    email: string
    password?: string
    displayName: string
    roles?: string[]
    metadata?: Record<string, unknown>
  },
) {
  const { email, password, ...profile } = input
  const user = await authKit.users.create(profile)
  await authKit.credentials.create(user.id, { email, ...(password === undefined ? {} : { password }) })
  return user
}

describe('plugin-auth — imperative users management', () => {
  it('creates a user (with password) who can sign in; roles + metadata land on the row', async () => {
    const { url, authKit } = await boot()
    const created = await createUser(authKit, {
      email: 'IV@x.com',
      password: 'passpass',
      displayName: 'Iv',
      metadata: { team: 'core' },
    })
    expect(created).toMatchObject({ displayName: 'Iv', roles: ['user'], metadata: { team: 'core' } })

    const g = h.client(app, { url, role: 'guest' })
    const { token, userId } = await g.signIn({ email: 'iv@x.com', password: 'passpass' }) // lowercased at create
    expect(userId).toBe(created.id)
    g.close()

    // the row (incl. metadata) is in the public directory
    const user = h.client(app, { url, role: 'user', params: { token } })
    const dir = user.collection('users').subscribe({})
    await dir.ready
    expect(dir.rows().find((r) => r.id === created.id)).toMatchObject({ metadata: { team: 'core' } })
    user.close()
  })

  it('creates a profile and passwordless credential: sign-in is refused until reset claim', async () => {
    let captured: string | undefined
    const { url, authKit } = await boot(undefined, ({ token }) => void (captured = token))
    await createUser(authKit, { email: 'inv@x.com', displayName: 'Invitee' })

    const g = h.client(app, { url, role: 'guest' })
    await expect(g.signIn({ email: 'inv@x.com', password: 'anything' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    // claim the account through the existing reset flow
    await g.requestPasswordReset({ email: 'inv@x.com' })
    expect(captured).toBeDefined()
    await g.confirmPasswordReset({ token: captured!, newPassword: 'chosen-by-user' })
    expect((await g.signIn({ email: 'inv@x.com', password: 'chosen-by-user' })).userId).toBeDefined()
    g.close()
  })

  it('rejects a duplicate email (CONFLICT) and an unknown role (BAD_REQUEST) at create', async () => {
    const { authKit } = await boot()
    await createUser(authKit, { email: 'dup@x.com', displayName: 'A' })
    await expect(createUser(authKit, { email: 'DUP@x.com', displayName: 'B' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(
      createUser(authKit, { email: 'ok@x.com', displayName: 'C', roles: ['ghost'] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('gets and finds users: IR filter passthrough, deactivated excluded unless asked', async () => {
    const { authKit } = await boot()
    const ann = await createUser(authKit, { email: 'ann@x.com', displayName: 'Ann' })
    const bob = await createUser(authKit, { email: 'bob@x.com', displayName: 'Bob' })

    expect((await authKit.users.get(ann.id))?.displayName).toBe('Ann')
    expect(await authKit.users.get('nope')).toBeUndefined()
    expect((await authKit.users.find({ filter: like('displayName', 'B%') })).map((u) => u.id)).toEqual([bob.id])

    await authKit.users.deactivate(bob.id)
    expect((await authKit.users.find()).map((u) => u.id)).toEqual([ann.id]) // deactivated hidden by default
    expect((await authKit.users.find({ includeDeactivated: true })).map((u) => u.id).sort()).toEqual(
      [ann.id, bob.id].sort(),
    )
  })

  it('update co-writes displayName/metadata: a live directory subscription sees the change', async () => {
    const { url, authKit } = await boot()
    const u = await createUser(authKit, { email: 'up@x.com', password: 'passpass', displayName: 'Old' })

    const g = h.client(app, { url, role: 'guest' })
    const { token } = await g.signIn({ email: 'up@x.com', password: 'passpass' })
    g.close()
    const client = h.client(app, { url, role: 'user', params: { token } })
    const dir = client.collection('users').subscribe({})
    await dir.ready

    const updated = await authKit.users.update(u.id, { displayName: 'New', metadata: { badge: 'gold' } })
    expect(updated).toMatchObject({ displayName: 'New', metadata: { badge: 'gold' } })
    await waitFor(() => dir.rows().some((r) => r.displayName === 'New'))
    expect(await authKit.users.update('nope', { displayName: 'X' }).catch((e) => e)).toMatchObject({
      code: 'NOT_FOUND',
    })
    client.close()
  })

  it('setRoles grants a contract role at connect time and rejects unknown roles', async () => {
    const { url, authKit } = await boot()
    const u = await createUser(authKit, { email: 'ro@x.com', password: 'passpass', displayName: 'Ro' })
    const g = h.client(app, { url, role: 'guest' })
    const { token } = await g.signIn({ email: 'ro@x.com', password: 'passpass' })
    g.close()

    // only ['user'] → an admin connection must never succeed (bounded, as in auth.integration)
    const asAdmin = h.client(app, { url, role: 'admin', params: { token } })
    const outcome = await Promise.race([
      asAdmin.adminOnly().then(() => 'ok' as const, () => 'rejected' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1500)),
    ])
    expect(outcome).not.toBe('ok')
    asAdmin.close()

    await authKit.users.setRoles(u.id, ['user', 'admin'])
    const granted = h.client(app, { url, role: 'admin', params: { token } })
    expect(await granted.adminOnly()).toEqual({ ok: true })
    granted.close()

    await expect(authKit.users.setRoles(u.id, ['ghost'])).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('deactivate blocks sign-in, revokes credentials, ends sessions, and kicks live connections', async () => {
    const { srv, url, authKit } = await boot()
    const u = await createUser(authKit, { email: 'de@x.com', password: 'passpass', displayName: 'De' })
    const g = h.client(app, { url, role: 'guest' })
    const { token } = await g.signIn({ email: 'de@x.com', password: 'passpass' })
    g.close()

    const live = h.client(app, { url, role: 'user', params: { token }, reconnect: false })
    const key = await live.createApiKey({ label: 'k', role: 'user' })
    await waitFor(() => srv.local.connections.length === 1)

    await authKit.users.deactivate(u.id)
    await waitFor(() => srv.local.connections.length === 0) // kicked
    live.close()

    // access token, API key, and password are all dead
    const stale = h.client(app, { url, role: 'user', params: { token } })
    expect(await stale.whoami()).toBeNull()
    stale.close()
    const byKey = h.client(app, { url, role: 'user', params: { apiKey: key.key } })
    expect(await byKey.whoami()).toBeNull()
    byKey.close()
    const g2 = h.client(app, { url, role: 'guest' })
    await expect(g2.signIn({ email: 'de@x.com', password: 'passpass' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })

    // the directory still serves the row (old messages keep their author) — flagged deactivated
    expect((await authKit.users.get(u.id))?.deletedAt).toEqual(expect.any(Number))

    await authKit.users.reactivate(u.id)
    expect((await g2.signIn({ email: 'de@x.com', password: 'passpass' })).userId).toBe(u.id)
    g2.close()
  })

  it('a deactivated user’s still-valid JWT no longer authenticates', async () => {
    const { url, authKit } = await boot({ secret: 'shhhh-a-very-secret-signing-key' })
    const u = await createUser(authKit, { email: 'jd@x.com', password: 'passpass', displayName: 'Jd' })
    const g = h.client(app, { url, role: 'guest' })
    const { token } = await g.signIn({ email: 'jd@x.com', password: 'passpass' })
    g.close()
    const user = h.client(app, { url, role: 'user', params: { token } })
    const { jwt } = await user.getToken()
    user.close()

    await authKit.users.deactivate(u.id)
    const stale = h.client(app, { url, role: 'user', params: { jwt } })
    expect(await stale.whoami()).toBeNull() // degraded to guest despite the unexpired JWT
    stale.close()
  })

  it('setPassword rotates the credential and flushes existing sessions', async () => {
    const { url, authKit } = await boot()
    const u = await createUser(authKit, { email: 'sp@x.com', password: 'oldpassword', displayName: 'Sp' })
    const g = h.client(app, { url, role: 'guest' })
    const { token } = await g.signIn({ email: 'sp@x.com', password: 'oldpassword' })

    await authKit.credentials.setPassword(u.id, 'newpassword')
    await expect(g.signIn({ email: 'sp@x.com', password: 'oldpassword' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect((await g.signIn({ email: 'sp@x.com', password: 'newpassword' })).userId).toBe(u.id)
    g.close()

    const stale = h.client(app, { url, role: 'user', params: { token } })
    expect(await stale.whoami()).toBeNull() // pre-rotation session flushed
    stale.close()
  })

  it('imperative APIs throw honestly before the server exists', async () => {
    const backend = memoryCollections()
    const authKit = auth({ contract: app, collections: backend })
    await expect(createUser(authKit, { email: 'x@x.com', displayName: 'X' })).rejects.toThrow(
      /createSuperLineServer/,
    )
  })
})

describe('plugin-auth — review hardening (reset purging, RMW lock, expiry guard)', () => {
  it('setPassword revokes pending password-reset tokens (a pre-rotation token cannot undo the rotation)', async () => {
    let captured: string | undefined
    const { url, authKit } = await boot(undefined, ({ token }) => void (captured = token))
    const u = await createUser(authKit, { email: 'rt@x.com', password: 'oldpassword', displayName: 'Rt' })

    const g = h.client(app, { url, role: 'guest' })
    await g.requestPasswordReset({ email: 'rt@x.com' })
    expect(captured).toBeDefined()

    await authKit.credentials.setPassword(u.id, 'rotated-by-admin')
    await expect(g.confirmPasswordReset({ token: captured!, newPassword: 'attacker' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect((await g.signIn({ email: 'rt@x.com', password: 'rotated-by-admin' })).userId).toBe(u.id)
    g.close()
  })

  it('deactivate revokes pending reset tokens AND confirmPasswordReset rejects a deactivated account', async () => {
    let captured: string | undefined
    const { url, authKit } = await boot(undefined, ({ token }) => void (captured = token))
    const u = await createUser(authKit, { email: 'dr@x.com', password: 'passpass', displayName: 'Dr' })

    const g = h.client(app, { url, role: 'guest' })
    await g.requestPasswordReset({ email: 'dr@x.com' })
    expect(captured).toBeDefined()

    await authKit.users.deactivate(u.id)
    await expect(g.confirmPasswordReset({ token: captured!, newPassword: 'attacker' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    // and no NEW token can be requested while deactivated (issue-side guard)
    captured = undefined
    await g.requestPasswordReset({ email: 'dr@x.com' })
    expect(captured).toBeUndefined()
    g.close()
  })

  it('reactivate purges access tokens that slipped past deactivate', async () => {
    const { srv, url, authKit } = await boot()
    const u = await createUser(authKit, { email: 'lv@x.com', password: 'passpass', displayName: 'Lv' })
    await authKit.users.deactivate(u.id)

    // simulate a raced leftover: an access-token row landing while the account is deactivated
    const { tokenHash } = await import('../src/crypto.js')
    const slipped = 'slipped-session-token'
    await srv
      .collection('accessTokens')
      .insert({ id: tokenHash(slipped), userId: u.id, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 })

    await authKit.users.reactivate(u.id)
    const stale = h.client(app, { url, role: 'user', params: { token: slipped } })
    expect(await stale.whoami()).toBeNull() // purged on reactivate, not revived
    stale.close()
  })

  it('update racing deactivate never un-bans the user (per-user serialization)', async () => {
    const { authKit } = await boot()
    for (let i = 0; i < 5; i++) {
      const u = await createUser(authKit, { email: `race${i}@x.com`, displayName: 'R' })
      await Promise.all([
        authKit.users.update(u.id, { displayName: 'renamed' }),
        authKit.users.deactivate(u.id),
      ])
      const after = await authKit.users.get(u.id)
      expect(after?.deletedAt).toEqual(expect.any(Number)) // the ban always survives
      expect(after?.displayName).toBe('renamed') // and the update still applied
    }
  })

  it('apiKeys.create rejects a non-positive expiresInMs instead of minting an immortal key', async () => {
    const { authKit } = await boot()
    const u = await createUser(authKit, { email: 'ex@x.com', displayName: 'Ex' })
    await expect(authKit.apiKeys.create(u.id, { role: 'user', label: 'k', expiresInMs: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(authKit.apiKeys.create(u.id, { role: 'user', label: 'k', expiresInMs: -5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    const k = await authKit.apiKeys.create(u.id, { role: 'user', label: 'k', expiresInMs: 60_000 })
    expect(k.expiresAt).toEqual(expect.any(Number))
  })
})

describe('plugin-auth — imperative API keys (agent provisioning)', () => {
  it('provisions an agent profile without a credential; server-minted key connects and revokes', async () => {
    const { url, authKit } = await boot()
    const agent = await authKit.users.create({ displayName: 'Deploy Bot' })
    const k = await authKit.apiKeys.create(agent.id, { role: 'user', label: 'agent' })
    expect(k.key).toMatch(/^slp_/) // raw key, returned once

    const svc = h.client(app, { url, role: 'user', params: { apiKey: k.key } })
    expect(await svc.secret()).toEqual({ me: agent.id })
    svc.close()

    const listed = await authKit.apiKeys.listFor(agent.id)
    expect(listed).toEqual([{ id: k.id, role: 'user', label: 'agent', createdAt: k.createdAt, expiresAt: null }])
    expect(listed[0]).not.toHaveProperty('key') // never the raw key again

    await authKit.apiKeys.revoke(k.id)
    const stale = h.client(app, { url, role: 'user', params: { apiKey: k.key } })
    expect(await stale.whoami()).toBeNull()
    stale.close()
  })

  it('rejects an unknown contract role, an unknown user, and a deactivated user', async () => {
    const { authKit } = await boot()
    const u = await createUser(authKit, { email: 'kx@x.com', displayName: 'Kx' })
    await expect(authKit.apiKeys.create(u.id, { role: 'ghost', label: 'x' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(authKit.apiKeys.create('nope', { role: 'user', label: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await authKit.users.deactivate(u.id)
    await expect(authKit.apiKeys.create(u.id, { role: 'user', label: 'x' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })
})
