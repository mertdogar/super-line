import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { authClient } from '@super-line/plugin-auth/client'
import { createHarness } from '../../server/test/harness.js'

// A tiny app: a protected `secret` on `user`, an `adminOnly` on `admin`, plus the auth plugin (adds
// the `guest` role, users/credentials/sessions collections, and signIn/signUp/signOut/whoami).
const app = defineContract({
  roles: {
    user: { clientToServer: { secret: { input: z.void(), output: z.object({ me: z.string() }) } } },
    admin: { clientToServer: { adminOnly: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract()],
})

// ── compile-time proof (never invoked): the REAL createSuperLineServer — auth types flow end-to-end ──
function _authTypeCheck(): void {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend })
  const srv = createSuperLineServer(app, {
    transports: [],
    collections: backend,
    authenticate: authKit.authenticate, // A = AuthResultOf<app> is inferred here (uniform AuthContext)
    identify: authKit.identify,
    plugins: [authKit.plugin],
  })
  // signIn/signUp/signOut/whoami are plugin-handled → subtracted; the host implements ONLY its own requests —
  // the fully-plugin-owned `shared` + `guest` blocks are now optional, so no empty `{}` noise. The handler
  // ctx is the AuthContext the plugin resolved.
  srv.implement({
    user: { secret: async (_i, ctx) => ({ me: ctx.userId ?? 'anon' }) },
    admin: { adminOnly: async () => ({ ok: true }) },
  })
  srv.implement({
    user: {
      secret: async () => ({ me: 'x' }),
      // @ts-expect-error signOut is plugin-handled → subtracted from implement()'s obligation
      signOut: async () => ({ ok: true }),
    },
    admin: { adminOnly: async () => ({ ok: true }) },
  })
}
void _authTypeCheck

const h = createHarness()
afterEach(() => h.dispose())

async function boot() {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const { srv, url } = await h.server(app, {
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin],
  })
  srv.implement({
    user: { secret: async (_i: unknown, ctx: { userId: string | null }) => ({ me: ctx.userId ?? 'anon' }) },
    admin: { adminOnly: async () => ({ ok: true }) },
  } as never)
  return { srv, url }
}

describe('plugin-auth — sign-up / login / roles', () => {
  it('signs up a guest, reconnects with the token as user, and resolves identity', async () => {
    const { url } = await boot()
    const guest = h.client(app, { url, role: 'guest' })
    const { token, userId, roles } = await guest.signUp({ email: 'Ann@x.com', password: 'hunter2', displayName: 'Ann' })
    expect(roles).toEqual(['user'])
    guest.close()

    const user = h.client(app, { url, role: 'user', params: { token } })
    expect(await user.whoami()).toMatchObject({ userId, displayName: 'Ann', roles: ['user'] })
    expect(await user.secret()).toEqual({ me: userId }) // ctx.userId reached the host handler
    // the public user directory is readable
    const dir = user.collection('users').subscribe({})
    await dir.ready
    expect(dir.rows().map((r) => r.displayName)).toEqual(['Ann'])
    user.close()
  })

  it('signs in an existing user, and rejects a wrong password / duplicate email', async () => {
    const { url } = await boot()
    const g1 = h.client(app, { url, role: 'guest' })
    await g1.signUp({ email: 'bo@x.com', password: 'correcthorse', displayName: 'Bo' })
    await expect(g1.signUp({ email: 'BO@x.com', password: 'other1', displayName: 'Bo2' })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await expect(g1.signIn({ email: 'bo@x.com', password: 'wrong' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    const { token, userId } = await g1.signIn({ email: 'bo@x.com', password: 'correcthorse' })
    g1.close()
    const user = h.client(app, { url, role: 'user', params: { token } })
    expect(await user.secret()).toEqual({ me: userId })
    user.close()
  })

  it('enforces data-driven roles: default user cannot open an admin connection until granted', async () => {
    const { srv, url } = await boot()
    const guest = h.client(app, { url, role: 'guest' })
    const { token, userId } = await guest.signUp({ email: 'cy@x.com', password: 'passpass', displayName: 'Cy' })
    guest.close()

    // requesting 'admin' with only ['user'] → authenticate throws FORBIDDEN → the connection never authorizes.
    // Bounded so we don't depend on whether the client rejects vs. retries: it simply must never SUCCEED.
    const asAdmin = h.client(app, { url, role: 'admin', params: { token } })
    const outcome = await Promise.race([
      asAdmin.adminOnly().then(() => 'ok' as const, () => 'rejected' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 1500)),
    ])
    expect(outcome).not.toBe('ok')
    asAdmin.close()

    // grant admin by co-writing the user row (roles are just data), then the same token opens an admin connection
    await srv.collection('users').update({ id: userId, displayName: 'Cy', roles: ['user', 'admin'], createdAt: Date.now() })
    const granted = h.client(app, { url, role: 'admin', params: { token } })
    expect(await granted.adminOnly()).toEqual({ ok: true })
    granted.close()
  })

  it('signs out (revokes the session): the old token degrades a reconnect to guest', async () => {
    const { url } = await boot()
    const guest = h.client(app, { url, role: 'guest' })
    const { token } = await guest.signUp({ email: 'di@x.com', password: 'passpass', displayName: 'Di' })
    guest.close()

    const user = h.client(app, { url, role: 'user', params: { token } })
    expect(await user.whoami()).not.toBeNull()
    await user.signOut() // deletes the session row
    user.close()

    // reconnecting with the revoked token: authenticate finds no session → guest, so whoami is null
    const stale = h.client(app, { url, role: 'user', params: { token } })
    expect(await stale.whoami()).toBeNull()
    stale.close()
  })

  it('keeps secret collections server-only (deny-all): a client cannot read sessions or credentials', async () => {
    const { url } = await boot()
    const guest = h.client(app, { url, role: 'guest' })
    const { token } = await guest.signUp({ email: 'ed@x.com', password: 'passpass', displayName: 'Ed' })
    guest.close()
    const user = h.client(app, { url, role: 'user', params: { token } })
    // a real session row exists; a denied read must surface as EITHER a rejected subscribe OR an empty set
    const sessions = user.collection('sessions').subscribe({})
    const denied = await sessions.ready.then(() => sessions.rows().length === 0).catch(() => true)
    expect(denied).toBe(true)
    user.close()
  })

  it('authClient hides the guest→user reconnect and drops back to guest on sign-out', async () => {
    const { url } = await boot()
    const a = authClient({
      authedRole: 'user',
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await a.ready
    expect(a.state.status).toBe('guest')
    await a.signUp({ email: 'fi@x.com', password: 'passpass', displayName: 'Fi' })
    expect(a.state).toMatchObject({ status: 'authed', roles: ['user'] }) // transparently rebuilt as `user`
    expect(await a.client.whoami()).toMatchObject({ displayName: 'Fi' })
    await a.signOut()
    expect(a.state.status).toBe('guest')
    expect(await a.client.whoami()).toBeNull()
  })
})
