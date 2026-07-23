/**
 * Plugin provenance (ADR-0016): attributing a merged contract entry to the fragment that contributed it.
 * The index is namespaced by where an entry lives, because the same name can appear in `shared` and in a role.
 */
import { describe, it, expect } from 'vitest'
import type { InspectedPlugin } from '@super-line/core'
import { buildOwnerIndex, contributionCounts, ownerOfCollection, ownerOfMessage } from '../src/lib/plugins'

const auth: InspectedPlugin = {
  name: 'auth',
  runtime: true,
  contract: {
    collections: ['users', 'sessions'],
    shared: { clientToServer: ['signOut', 'whoami'], serverToClient: [] },
    roles: { guest: { clientToServer: ['signIn', 'signUp'], serverToClient: [] } },
  },
}
const chat: InspectedPlugin = {
  name: 'chat',
  runtime: true,
  contract: {
    collections: ['channels'],
    shared: { clientToServer: ['sendMessage'], serverToClient: ['chat.streamDelta'] },
  },
}
const inspectorOnly: InspectedPlugin = { name: 'inspector', runtime: true }

describe('plugin owner index', () => {
  const index = buildOwnerIndex([auth, chat, inspectorOnly])

  it('attributes collections to their declaring plugin', () => {
    expect(ownerOfCollection(index, 'users')).toBe('auth')
    expect(ownerOfCollection(index, 'channels')).toBe('chat')
  })

  it('leaves host-declared entries unowned', () => {
    expect(ownerOfCollection(index, 'invoices')).toBeUndefined()
    expect(ownerOfMessage(index, undefined, 'clientToServer', 'hostRequest')).toBeUndefined()
  })

  it('separates shared entries from role entries of the same name', () => {
    const shadow: InspectedPlugin = {
      name: 'shadow',
      runtime: true,
      contract: { collections: [], roles: { guest: { clientToServer: ['whoami'], serverToClient: [] } } },
    }
    const both = buildOwnerIndex([auth, shadow])
    expect(ownerOfMessage(both, undefined, 'clientToServer', 'whoami')).toBe('auth')
    expect(ownerOfMessage(both, 'guest', 'clientToServer', 'whoami')).toBe('shadow')
  })

  it('separates the two directions', () => {
    expect(ownerOfMessage(index, undefined, 'serverToClient', 'chat.streamDelta')).toBe('chat')
    expect(ownerOfMessage(index, undefined, 'clientToServer', 'chat.streamDelta')).toBeUndefined()
  })

  it('contributes nothing for a runtime-only plugin', () => {
    expect(contributionCounts(inspectorOnly)).toEqual({ collections: 0, messages: 0 })
    expect(buildOwnerIndex([inspectorOnly]).size).toBe(0)
  })

  it('counts contributions across shared and every role', () => {
    expect(contributionCounts(auth)).toEqual({ collections: 2, messages: 4 })
    expect(contributionCounts(chat)).toEqual({ collections: 1, messages: 2 })
  })

  it('is empty when the node reported no plugins at all', () => {
    expect(buildOwnerIndex(undefined).size).toBe(0)
  })
})
