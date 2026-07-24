import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineContract, SuperLineError, type Handshake } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth, type AuthHooks, type AuthServerOptions } from '@super-line/plugin-auth/server'
import { createHarness } from '../../server/test/harness.js'

// The server-side auth hooks (ADR-0017): before/after around `authenticate` + the imperative kit.
const app = defineContract({
  roles: {
    user: { clientToServer: { secret: { input: z.void(), output: z.object({ me: z.string() }) } } },
    admin: { clientToServer: { adminOnly: { input: z.void(), output: z.object({ ok: z.boolean() }) } } },
  },
  plugins: [authContract()],
})

const h = createHarness()
afterEach(() => h.dispose())

async function boot(overrides: Partial<AuthServerOptions<typeof app>> = {}) {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'], ...overrides })
  const { srv, url } = await h.server(app, {
    nodeKey: 'auth-hooks-test',
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

const withHooks = (hooks: AuthHooks<typeof app>, extra: Partial<AuthServerOptions<typeof app>> = {}) =>
  boot({ hooks, ...extra })

const hs = (query: Record<string, string>): Handshake => ({ transport: 'loopback', headers: {}, query, raw: null })

// ── Phase 1 · authenticate ─────────────────────────────────────────────────────────────────────
describe('plugin-auth hooks — authenticate', () => {
  it('before receives the handshake and can reject the connection (throw)', async () => {
    const before = vi.fn((handshake: Handshake) => {
      if (handshake.query.block) throw new SuperLineError('FORBIDDEN', 'blocked')
    })
    const { authKit } = await withHooks({ authenticate: { before } })
    await expect(authKit.authenticate(hs({ role: 'guest', block: '1' }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(before).toHaveBeenCalled()
    // a non-blocked handshake still resolves
    expect((await authKit.authenticate(hs({ role: 'guest' }))).role).toBe('guest')
  })

  it('after fires for a guest resolution and can TRANSFORM the result', async () => {
    const after = vi.fn((result: { role: string; ctx: { userId: string | null } }) => ({
      ...result,
      ctx: { ...result.ctx, userId: 'ENRICHED' },
    }))
    const { authKit } = await withHooks({ authenticate: { after: after as never } })
    const result = await authKit.authenticate(hs({ role: 'guest' }))
    expect((after.mock.calls[0]![0] as { role: string }).role).toBe('guest') // fired for a guest
    expect((result.ctx as { userId: string | null }).userId).toBe('ENRICHED') // transform applied
  })

  it('after can reject the connection (throw)', async () => {
    const { authKit } = await withHooks({
      authenticate: { after: () => { throw new SuperLineError('FORBIDDEN', 'denied') } },
    })
    await expect(authKit.authenticate(hs({ role: 'guest' }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

// ── Phase 2 · users + credentials ──────────────────────────────────────────────────────────────
describe('plugin-auth hooks — users + credentials', () => {
  it('users.create.before transforms the input; after observes the row', async () => {
    const after = vi.fn()
    const { authKit } = await withHooks({
      users: { create: { before: (i) => ({ ...i, displayName: i.displayName.trim() }), after } },
    })
    const u = await authKit.users.create({ displayName: '  Spaced  ' })
    expect(u.displayName).toBe('Spaced')
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Spaced' }))
  })

  it('users.create.before vetoes by throwing — nothing is written', async () => {
    const { authKit } = await withHooks({
      users: { create: { before: () => { throw new SuperLineError('BAD_REQUEST', 'no') } } },
    })
    await expect(authKit.users.create({ displayName: 'X' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await authKit.users.find()).toHaveLength(0)
  })

  it('users.setRoles.after fires after the roles change', async () => {
    const after = vi.fn()
    const { authKit } = await withHooks({ users: { setRoles: { after } } })
    const u = await authKit.users.create({ displayName: 'R' })
    await authKit.users.setRoles(u.id, ['admin'])
    expect(after).toHaveBeenCalledTimes(1)
    expect((await authKit.users.get(u.id))?.roles).toEqual(['admin'])
  })

  it('users.deactivate.before CANNOT veto — a throw routes to onHookError and deactivation proceeds', async () => {
    const onHookError = vi.fn()
    const { authKit } = await withHooks(
      { users: { deactivate: { before: () => { throw new Error('nope') } } } },
      { onHookError },
    )
    const u = await authKit.users.create({ displayName: 'Del' })
    await authKit.users.deactivate(u.id)
    expect(onHookError).toHaveBeenCalledWith(expect.any(Error), 'users.deactivate')
    expect((await authKit.users.get(u.id))?.deletedAt).toBeTruthy() // happened despite the throw
  })

  it('the deactivate cascade is SILENT — revoking the user’s keys fires no apiKeys.revoke hook', async () => {
    const revokeBefore = vi.fn()
    const { authKit } = await withHooks({ apiKeys: { revoke: { before: revokeBefore } } })
    const u = await authKit.users.create({ displayName: 'Casc' })
    await authKit.apiKeys.create(u.id, { role: 'user', label: 'k' })
    await authKit.users.deactivate(u.id) // internally deletes the api key
    expect(revokeBefore).not.toHaveBeenCalled()
  })

  it('credentials.setPassword.before sees the plaintext password', async () => {
    const seen: string[] = []
    const { authKit } = await withHooks({
      credentials: { setPassword: { before: (i) => void seen.push(i.newPassword) } },
    })
    const u = await authKit.users.create({ displayName: 'P' })
    await authKit.credentials.create(u.id, { email: 'p@x.com', password: 'orig-pass' })
    await authKit.credentials.setPassword(u.id, 'brand-new-pass')
    expect(seen).toEqual(['brand-new-pass'])
  })
})

// ── Phase 3 · apiKeys + tokens ─────────────────────────────────────────────────────────────────
describe('plugin-auth hooks — apiKeys + tokens', () => {
  it('apiKeys.create.after receives the raw slp_ key', async () => {
    let captured: string | undefined
    const { authKit } = await withHooks({ apiKeys: { create: { after: (r) => void (captured = r.key) } } })
    const u = await authKit.users.create({ displayName: 'K' })
    const { key } = await authKit.apiKeys.create(u.id, { role: 'user', label: 'agent' })
    expect(key).toMatch(/^slp_/)
    expect(captured).toBe(key)
  })

  it('apiKeys.create.before can veto — no key is written', async () => {
    const { authKit } = await withHooks({
      apiKeys: { create: { before: () => { throw new SuperLineError('FORBIDDEN', 'no keys') } } },
    })
    const u = await authKit.users.create({ displayName: 'K2' })
    await expect(authKit.apiKeys.create(u.id, { role: 'user', label: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await authKit.apiKeys.listFor(u.id)).toHaveLength(0)
  })

  it('hooks may be async — an async before awaits then vetoes; an async after is awaited before the op returns', async () => {
    const order: string[] = []
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

    // async before that resolves and vetoes only some inputs
    const gated = await withHooks({
      users: {
        create: {
          before: async (i) => {
            await tick()
            if (i.displayName === 'banned') throw new SuperLineError('FORBIDDEN', 'blocked')
            return { ...i, displayName: i.displayName.toUpperCase() }
          },
        },
      },
    })
    await expect(gated.authKit.users.create({ displayName: 'banned' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await gated.authKit.users.find()).toHaveLength(0) // async veto → nothing written
    const ok = await gated.authKit.users.create({ displayName: 'allowed' })
    expect(ok.displayName).toBe('ALLOWED') // async transform applied

    // async after is awaited before the kit method resolves
    const { authKit } = await withHooks({
      users: {
        setRoles: {
          after: async () => {
            order.push('after:start')
            await tick()
            order.push('after:end')
          },
        },
      },
    })
    const u = await authKit.users.create({ displayName: 'A' })
    await authKit.users.setRoles(u.id, ['admin'])
    order.push('caller-resumed')
    expect(order).toEqual(['after:start', 'after:end', 'caller-resumed']) // caller waited for the async after
  })

  it('tokens.mintSigned after fires; mintSealed.before can attach a sealed claim', async () => {
    const signedAfter = vi.fn()
    const { authKit } = await withHooks(
      {
        tokens: {
          mintSigned: { after: signedAfter },
          mintSealed: { before: (i) => ({ ...i, sealed: { injected: true } }) },
        },
      },
      { jwt: { secret: 'test-secret' } },
    )
    const u = await authKit.users.create({ displayName: 'T' })
    const signed = await authKit.tokens.mintSigned(u.id, { claims: { a: 1 } })
    expect(signedAfter).toHaveBeenCalledWith(expect.objectContaining({ token: signed.token }))
    const sealed = await authKit.tokens.mintSealed(u.id)
    expect((await authKit.tokens.verify(sealed.token))?.sealed).toMatchObject({ injected: true })
  })
})
