import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'
import { WebSocket } from 'ws'
import { defineContract, INSPECTOR_SUBPROTOCOL, SuperLineError } from '@super-line/core'
import type { Handshake } from '@super-line/core'
import { inspector } from '@super-line/plugin-inspector'
import { connectInspector, createHarness } from './harness.js'

// ADR-0022: the Control Center channel short-circuits the HOST's authenticate, so the inspector plugin
// authorizes its own admission at the handshake. A refusal is a 4401 close on an ESTABLISHED socket, not a
// refused upgrade — a browser can read the former and cannot distinguish the latter from an unreachable host.

const contract = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.number() } } } },
})

const authenticate = () => ({ role: 'user' as const, ctx: {} })

const h = createHarness()
const ENV_KEYS = ['SUPER_LINE_INSPECTOR_USER', 'SUPER_LINE_INSPECTOR_PASSWORD'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
afterEach(() => {
  h.dispose()
  // `process.env.X = undefined` assigns the STRING "undefined" — an unset var has to be deleted.
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

/** Dial the reserved class and report how it ended: opened, or closed with a code + reason. */
function dial(url: string): Promise<{ opened: boolean; code?: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    let opened = false
    ws.on('open', () => {
      opened = true
    })
    ws.on('close', (code, reason) => resolve({ opened, code, reason: reason.toString() }))
    ws.on('error', reject)
  })
}

describe('inspector admission (ADR-0022)', () => {
  it('stays open when no credential is configured', async () => {
    delete process.env.SUPER_LINE_INSPECTOR_PASSWORD
    const { url } = await h.server(contract, { authenticate, plugins: [inspector()] })
    const insp = await connectInspector(url)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    insp.close()
  })

  it('admits a connection presenting the configured credentials', async () => {
    const { url } = await h.server(contract, {
      authenticate,
      plugins: [inspector({ auth: { username: 'admin', password: 's3cret' } })],
    })
    const insp = await connectInspector(`${url}/?user=admin&password=s3cret`)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    insp.close()
  })

  it('closes 4401 on a wrong password, a wrong user, and no credentials at all', async () => {
    const { url } = await h.server(contract, {
      authenticate,
      plugins: [inspector({ auth: { username: 'admin', password: 's3cret' } })],
    })
    for (const query of ['?user=admin&password=nope', '?user=root&password=s3cret', '']) {
      const outcome = await dial(`${url}/${query}`)
      // The socket opens first — that is the whole point: a browser can read this code, but not a 401 upgrade.
      expect(outcome.opened).toBe(true)
      expect(outcome.code).toBe(4401)
      expect(outcome.reason).toBe('invalid inspector credentials')
    }
  })

  it('defaults the username to admin and reads the env vars when `auth` is omitted', async () => {
    process.env.SUPER_LINE_INSPECTOR_PASSWORD = 'from-env'
    delete process.env.SUPER_LINE_INSPECTOR_USER
    const { url } = await h.server(contract, { authenticate, plugins: [inspector()] })
    const insp = await connectInspector(`${url}/?user=admin&password=from-env`)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    insp.close()
    expect((await dial(`${url}/?user=admin&password=wrong`)).code).toBe(4401)
  })

  it('lets an explicit `auth` option override the env vars', async () => {
    process.env.SUPER_LINE_INSPECTOR_PASSWORD = 'from-env'
    const { url } = await h.server(contract, {
      authenticate,
      plugins: [inspector({ auth: { password: 'explicit' } })],
    })
    const insp = await connectInspector(`${url}/?user=admin&password=explicit`)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    insp.close()
    expect((await dial(`${url}/?user=admin&password=from-env`)).code).toBe(4401)
  })

  it('accepts a host predicate, surfacing its throw as the close reason', async () => {
    const seen: string[] = []
    const { url } = await h.server(contract, {
      authenticate,
      plugins: [
        inspector({
          auth: (handshake: Handshake) => {
            seen.push(handshake.transport)
            if (handshake.query.ticket !== 'let-me-in') throw new SuperLineError('UNAUTHORIZED', 'admin role required')
            return { username: 'via-predicate' }
          },
        }),
      ],
    })
    const refused = await dial(`${url}/?ticket=nope`)
    expect(refused.code).toBe(4401)
    expect(refused.reason).toBe('admin role required')

    const insp = await connectInspector(`${url}/?ticket=let-me-in`)
    expect(insp.protocol).toBe(INSPECTOR_SUBPROTOCOL)
    insp.close()
    expect(seen).toEqual(['websocket', 'websocket'])
  })

  it('never reaches the host authenticate, admitted or refused', async () => {
    let hostCalls = 0
    const { url } = await h.server(contract, {
      authenticate: () => {
        hostCalls++
        return authenticate()
      },
      plugins: [inspector({ auth: { password: 's3cret' } })],
    })
    expect((await dial(`${url}/?user=admin&password=wrong`)).code).toBe(4401)
    const insp = await connectInspector(`${url}/?user=admin&password=s3cret`)
    insp.close()
    expect(hostCalls).toBe(0)
  })
})
