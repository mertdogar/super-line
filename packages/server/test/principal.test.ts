import { describe, expect, it } from 'vitest'
import { resolvePrincipal, type Conn } from '../src/index.js'

// resolvePrincipal is the ACL identity for stores: a stable `identify` key when configured,
// else the random per-connection `conn.id`. It must always return a string (never undefined).
const connWith = (id: string, ctx: unknown = {}) => ({ id, ctx }) as unknown as Conn

describe('resolvePrincipal', () => {
  it('falls back to conn.id when identify is not configured', () => {
    expect(resolvePrincipal(connWith('conn-1'))).toBe('conn-1')
  })

  it('falls back to conn.id when identify returns undefined (anonymous)', () => {
    expect(resolvePrincipal(connWith('conn-2'), () => undefined)).toBe('conn-2')
  })

  it('uses the identify key when configured', () => {
    const conn = connWith('conn-3', { userId: 'user-42' })
    expect(resolvePrincipal(conn, (c) => (c.ctx as { userId: string }).userId)).toBe('user-42')
  })

  it('passes the connection to identify', () => {
    const conn = connWith('conn-4')
    let seen: Conn | undefined
    resolvePrincipal(conn, (c) => {
      seen = c
      return undefined
    })
    expect(seen).toBe(conn)
  })
})
