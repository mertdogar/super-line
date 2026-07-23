/**
 * The [[Identity lens]]: joining plugin-auth's user directory onto connections. Every helper must degrade
 * to raw ids — a server without the auth plugin, a directory row that never arrived, or a redacted field
 * must all still render something useful.
 */
import { describe, it, expect } from 'vitest'
import type { ConnDescriptor, InspectedContract } from '@super-line/core'
import {
  EMPTY_DIRECTORY,
  authLensActive,
  connLabel,
  connectedUsers,
  displayNameOf,
  rowToIdentity,
  userIdsOf,
  type Directory,
} from '../src/lib/identity'

const contractWith = (plugins: InspectedContract['plugins']): InspectedContract => ({
  shared: { clientToServer: [], serverToClient: [] },
  roles: {},
  ...(plugins ? { plugins } : {}),
})

const conn = (over: Partial<ConnDescriptor>): ConnDescriptor => ({
  id: 'aaaaaaaa-1111',
  role: 'user',
  nodeId: 'n1',
  nodeName: 'node-1',
  connectedAt: 0,
  rooms: [],
  ...over,
})

const directory: Directory = new Map([
  ['u1', { userId: 'u1', displayName: 'Mert Dogar', roles: ['user'] }],
  ['u2', { userId: 'u2', displayName: 'Ada' }],
])

describe('auth lens activation', () => {
  it('is active when auth is registered and declares the directory', () => {
    const contract = contractWith([
      { name: 'auth', runtime: true, contract: { collections: ['users', 'sessions'] } },
    ])
    expect(authLensActive(contract)).toBe(true)
  })

  it('is inactive when the fragment is merged but the server half is missing', () => {
    const contract = contractWith([{ name: 'auth', runtime: false, contract: { collections: ['users'] } }])
    expect(authLensActive(contract)).toBe(false) // nobody writes that directory
  })

  it('is inactive without the auth plugin, and on nodes that report no plugins', () => {
    expect(authLensActive(contractWith([{ name: 'chat', runtime: true, contract: { collections: ['channels'] } }]))).toBe(false)
    expect(authLensActive(contractWith(undefined))).toBe(false)
    expect(authLensActive(null)).toBe(false)
  })
})

describe('reading a directory row', () => {
  it('reads the fields the Control Center understands', () => {
    expect(
      rowToIdentity({ id: 'u1', displayName: 'Mert', roles: ['user', 'admin'], metadata: { seat: 3 }, createdAt: 5 }),
    ).toEqual({ userId: 'u1', displayName: 'Mert', roles: ['user', 'admin'], metadata: { seat: 3 }, createdAt: 5 })
  })

  it('tolerates redacted or missing fields, keeping the id', () => {
    // `redact: ['displayName']` replaces the value with a marker object, not a string
    expect(rowToIdentity({ id: 'u1', displayName: { redacted: true } })).toEqual({ userId: 'u1' })
    expect(rowToIdentity({ id: 'u1' })).toEqual({ userId: 'u1' })
  })

  it('rejects rows with no usable key', () => {
    expect(rowToIdentity({ displayName: 'Mert' })).toBeNull()
    expect(rowToIdentity(null)).toBeNull()
    expect(rowToIdentity('nope')).toBeNull()
  })
})

describe('connection labels', () => {
  it('leads with the display name, then role and connection id', () => {
    expect(connLabel({ id: 'ffffffff-0000', role: 'user', userId: 'u1' }, directory)).toEqual({
      title: 'Mert Dogar',
      subtitle: 'user · ffffffff',
    })
  })

  it('falls back to the pre-lens rendering when the directory has no row', () => {
    expect(connLabel({ id: 'ffffffff-0000', role: 'user', userId: 'u9' }, directory)).toEqual({
      title: 'user',
      subtitle: 'u9',
    })
  })

  it('shows role and connection id for an unauthenticated connection', () => {
    expect(connLabel({ id: 'ffffffff-0000', role: 'guest' }, EMPTY_DIRECTORY)).toEqual({
      title: 'guest',
      subtitle: 'ffffffff',
    })
  })

  it('resolves nothing without a user key', () => {
    expect(displayNameOf(directory, undefined)).toBeUndefined()
  })
})

describe('connected users', () => {
  const conns = [
    conn({ id: 'c1', userId: 'u1' }),
    conn({ id: 'c2', userId: 'u1' }),
    conn({ id: 'c3', userId: 'u2' }),
    conn({ id: 'c4' }), // unauthenticated
  ]

  it('collects the distinct keys worth fetching, ignoring anonymous conns', () => {
    expect(userIdsOf(conns).sort()).toEqual(['u1', 'u2'])
  })

  // alphabetical, not by count: the list updates live, and a count-ordered list reshuffles under the cursor
  it('counts connections per identity', () => {
    expect(connectedUsers(conns, directory)).toEqual([
      { userId: 'u2', label: 'Ada', named: true, count: 1 },
      { userId: 'u1', label: 'Mert Dogar', named: true, count: 2 },
    ])
  })

  it('sorts named identities ahead of unresolved ones', () => {
    const partial: Directory = new Map([['u2', { userId: 'u2', displayName: 'Ada' }]])
    expect(connectedUsers(conns, partial).map((u) => u.label)).toEqual(['Ada', 'u1'])
  })
})
