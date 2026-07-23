/**
 * Contract plugins: `defineContract({ plugins: [...] })` merges a plugin-contributed fragment
 * (collections + roles + shared surface) INTO the contract via intersection, so end-to-end types
 * (`RowOf`, per-role `Requests`, `client.collection`) flow from the single materialized contract —
 * the contract-time half of a paired plugin (see ADR-0005). Type assertions here are enforced only
 * by `pnpm typecheck`; the `describe` block covers the runtime merge + collision throws.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineContract, defineContractPlugin, validate } from '@super-line/core'
import type { Contract, CollectionName, RowOf, Requests, RoleOf } from '@super-line/core'

// an auth-shaped contract plugin: two collections + a brand-new `guest` role + a request merged into `user`
const authPlugin = defineContractPlugin('auth', {
  collections: {
    users: { schema: z.object({ id: z.string(), displayName: z.string(), roles: z.array(z.string()) }), key: 'id' },
    sessions: { schema: z.object({ id: z.string(), userId: z.string() }), key: 'id' },
  },
  roles: {
    guest: {
      clientToServer: {
        signIn: { input: z.object({ email: z.string(), password: z.string() }), output: z.object({ token: z.string() }) },
        signUp: {
          input: z.object({ email: z.string(), password: z.string(), displayName: z.string() }),
          output: z.object({ token: z.string() }),
        },
      },
    },
    user: {
      clientToServer: { signOut: { input: z.void(), output: z.void() } },
    },
  },
})

const contract = defineContract({
  roles: {
    user: {
      clientToServer: {
        sendMessage: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
    },
  },
  collections: {
    messages: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
  },
  plugins: [authPlugin],
})

type Resolved = typeof contract

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// (1) the plugin's brand-new role appears; base roles survive
type _roles = Expect<Equal<RoleOf<Resolved>, 'user' | 'guest'>>
// (2) collection NAMES = base ∪ fragment (this is what gates `client.collection(name)`)
type _colls = Expect<Equal<CollectionName<Resolved>, 'messages' | 'users' | 'sessions'>>
// (3) RowOf infers the fragment's row type through the merge; base row unaffected
type _userRow = Expect<Equal<RowOf<Resolved, 'users'>, { id: string; displayName: string; roles: string[] }>>
type _msgRow = Expect<Equal<RowOf<Resolved, 'messages'>, { id: string; text: string }>>
// (4) a new role's requests, AND a fragment request merged INTO an existing role
type _guestReqs = Expect<Equal<keyof Requests<Resolved, 'guest'>, 'signIn' | 'signUp'>>
type _userReqs = Expect<Equal<keyof Requests<Resolved, 'user'>, 'sendMessage' | 'signOut'>>
// (5) the resolved contract is a real Contract — assignable to what the factories demand
type _isContract = Expect<Resolved extends Contract ? true : false>
// (6) mirror `collection<N extends CollectionName<C>>(n): …RowOf<C,N>` — name gated, row type flows
type ClientCollection<N extends CollectionName<Resolved>> = RowOf<Resolved, N>
type _clientUsers = Expect<Equal<ClientCollection<'users'>, { id: string; displayName: string; roles: string[] }>>
// @ts-expect-error — 'nope' is not a collection name on the merged contract (name gated by CollectionName)
type _clientBad = ClientCollection<'nope'>

export type _Probe = [_roles, _colls, _userRow, _msgRow, _guestReqs, _userReqs, _isContract, _clientUsers, _clientBad]

describe('contract plugins (defineContract plugins fragment-merge)', () => {
  it('merges plugin collections + roles into the resolved contract', () => {
    expect(Object.keys(contract.collections!).sort()).toEqual(['messages', 'sessions', 'users'])
    expect(Object.keys(contract.roles).sort()).toEqual(['guest', 'user'])
    expect(Object.keys(contract.roles.user.clientToServer!).sort()).toEqual(['sendMessage', 'signOut'])
    expect(Object.keys(contract.roles.guest.clientToServer!).sort()).toEqual(['signIn', 'signUp'])
  })

  it('keeps merged-in request defs intact (schema still validates)', async () => {
    const schema = contract.roles.guest.clientToServer!.signIn.input
    await expect(validate(schema, { email: 'a@b.c', password: 'x' })).resolves.toEqual({ email: 'a@b.c', password: 'x' })
  })

  it('throws when a plugin collection name collides with a base collection', () => {
    expect(() =>
      defineContract({
        roles: { user: {} },
        collections: { users: { schema: z.object({ id: z.string() }), key: 'id' } },
        plugins: [authPlugin], // authPlugin also declares `users`
      }),
    ).toThrow(/collides/i)
  })

  it('throws when a plugin merges a request key an existing role already has', () => {
    const dup = defineContractPlugin('dup', {
      roles: { user: { clientToServer: { sendMessage: { input: z.void(), output: z.void() } } } },
    })
    expect(() =>
      defineContract({
        roles: { user: { clientToServer: { sendMessage: { input: z.void(), output: z.void() } } } },
        plugins: [dup],
      }),
    ).toThrow(/duplicate clientToServer key 'sendMessage'/)
  })

  it('leaves a plugin-free contract untouched (identity)', () => {
    const plain = { roles: { user: {} }, collections: { m: { schema: z.object({ id: z.string() }), key: 'id' } } }
    expect(defineContract(plain)).toBe(plain)
  })

  // ADR-0016: the merge used to discard `plugins`, so nothing downstream could attribute a merged key to
  // the fragment that contributed it. The merged contract now carries the fragments that formed it.
  it('retains the plugin fragments on the merged contract (provenance)', () => {
    expect(contract.plugins?.map((p) => p.name)).toEqual(['auth'])
    const fragment = contract.plugins![0]!.fragment
    expect(Object.keys(fragment.collections ?? {}).sort()).toEqual(['sessions', 'users'])
    expect(Object.keys(fragment.roles?.guest?.clientToServer ?? {}).sort()).toEqual(['signIn', 'signUp'])
    // provenance is the fragment as authored — NOT the merged product
    expect(Object.keys(fragment.roles?.user?.clientToServer ?? {})).toEqual(['signOut'])
    expect(Object.keys(contract.roles.user.clientToServer!).sort()).toEqual(['sendMessage', 'signOut'])
  })

  it('has no plugins key on a plugin-free contract', () => {
    const plain: Contract = defineContract({ roles: { user: {} } })
    expect(plain.plugins).toBeUndefined()
  })
})
