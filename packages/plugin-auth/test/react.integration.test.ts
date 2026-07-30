// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { authClient, type TokenStorage } from '@super-line/plugin-auth/client'
import { SuperLineAuthProvider, useAuth } from '@super-line/plugin-auth/react'
import {
  createSuperLineHooks,
  useCollection as boundUseCollection,
  useMaybeClient as boundUseMaybeClient,
} from '@super-line/react'
import { createHarness } from '../../server/test/harness.js'

const app = defineContract({
  roles: {
    user: { clientToServer: { secret: { input: z.void(), output: z.object({ me: z.string() }) } } },
  },
  plugins: [authContract()],
})

// The rewire's whole point: SuperLineAuthProvider feeds @super-line/react's SHARED module-level
// context. These are the shared exports, cast-bound to this test's contract (Register must stay
// undeclared in the root typecheck program — see the tripwire in packages/react/test/hooks.test.ts).
type Bound = ReturnType<typeof createSuperLineHooks<typeof app, 'user'>>
const useSharedMaybeClient = boundUseMaybeClient as unknown as Bound['useMaybeClient']
const useSharedCollection = boundUseCollection as unknown as Bound['useCollection']

const h = createHarness()
afterEach(async () => {
  cleanup()
  await h.dispose()
})

const memStorage = (): TokenStorage => {
  let v: string | null = null
  return { get: () => v, set: (t) => (v = t) }
}

async function boot() {
  const backend = memoryCollections()
  const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
  const { srv, url } = await h.server(app, {
    nodeKey: 'auth-react-test',
    authenticate: authKit.authenticate,
    identify: authKit.identify,
    collections: backend,
    plugins: [authKit.plugin],
  })
  srv.implement({
    user: { secret: async (_i: unknown, ctx: { userId: string | null }) => ({ me: ctx.userId ?? 'anon' }) },
  } as never)
  return { srv, url }
}

type ProviderProps = { children?: ReactNode } & Record<string, unknown>
const Provider = SuperLineAuthProvider as unknown as (props: ProviderProps) => ReactNode

function optionsWrapper(url: string, storage: TokenStorage) {
  return ({ children }: { children: ReactNode }) =>
    createElement(Provider, {
      authedRole: 'user',
      storage,
      connect: ({ role, params }: { role: string; params: Record<string, string> }) =>
        h.client(app, { url, role: role as 'user', params }),
      children,
    })
}

describe('plugin-auth react — the session feeds the SHARED binding', () => {
  it('idles the shared hooks as guest, feeds them the live client once authed, and idles again on sign-out', async () => {
    const { url } = await boot()
    const { result } = renderHook(
      () => ({
        auth: useAuth(),
        client: useSharedMaybeClient(),
        users: useSharedCollection('users'),
      }),
      { wrapper: optionsWrapper(url, memStorage()) },
    )

    // Boot settles as guest: the shared context holds NO client, the shared hooks idle.
    await waitFor(() => expect(result.current.auth.state.pending).toBe(false))
    expect(result.current.auth.state.status).toBe('guest')
    expect(result.current.client).toBeNull()
    expect(result.current.users.rows).toEqual([])
    expect(result.current.users.ready).toBe(false)

    // Sign up → session replacement → the SHARED module-level hooks see the authed client.
    await act(async () => {
      await result.current.auth.signUp({ email: 'ann@x.com', password: 'hunter22', displayName: 'Ann' })
    })
    expect(result.current.auth.state.status).toBe('authed')
    await waitFor(() => expect(result.current.client).not.toBeNull())
    await waitFor(() => expect(result.current.users.ready).toBe(true))
    expect(result.current.users.rows.map((r) => (r as { displayName: string }).displayName)).toEqual(['Ann'])

    // Sign out → back to guest → the shared hooks idle again.
    await act(async () => {
      await result.current.auth.signOut()
    })
    expect(result.current.auth.state.status).toBe('guest')
    await waitFor(() => expect(result.current.client).toBeNull())
    expect(result.current.users.rows).toEqual([])
  })

  it('adopts an externally-owned auth client and never closes it on unmount', async () => {
    const { url } = await boot()
    const a = authClient<typeof app, 'user'>({
      authedRole: 'user',
      storage: memStorage(),
      connect: ({ role, params }) => h.client(app, { url, role: role as 'user', params }),
    })
    await a.ready

    const { result, unmount } = renderHook(() => useSharedMaybeClient(), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(Provider, { client: a, children }),
    })
    await act(async () => {
      await a.signUp({ email: 'bo@x.com', password: 'hunter22', displayName: 'Bo' })
    })
    await waitFor(() => expect(result.current).not.toBeNull())

    unmount()
    // The instance is the app's: still alive and usable after the provider is gone.
    expect(await a.client.whoami()).toMatchObject({ displayName: 'Bo' })
  })
})
