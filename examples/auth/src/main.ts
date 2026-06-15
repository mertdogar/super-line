import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SocketError } from '@super-line/core'
import { createSocketServer } from '@super-line/server'
import { createClient } from '@super-line/client'
import { api } from './contract.js'

// Pretend token store. In a real app, verify a JWT / session here instead.
const TOKENS: Record<string, { user: string; role: 'user' | 'admin' }> = {
  tok_ada: { user: 'ada', role: 'admin' },
  tok_grace: { user: 'grace', role: 'user' },
}

async function main(): Promise<void> {
  const server = http.createServer()
  const srv = createSocketServer(api, {
    server,
    // runs at the HTTP upgrade — resolve the role from the token, verify the claim, throw to reject
    authenticate: (req) => {
      const u = new URL(req.url ?? '', 'http://localhost')
      const rec = TOKENS[u.searchParams.get('token') ?? '']
      if (!rec) throw new SocketError('UNAUTHORIZED', 'invalid token')
      if (rec.role !== u.searchParams.get('role')) {
        throw new SocketError('FORBIDDEN', 'token does not grant that role')
      }
      return rec.role === 'admin'
        ? { role: 'admin' as const, ctx: { user: rec.user } }
        : { role: 'user' as const, ctx: { user: rec.user } }
    },
  })

  srv.implement({
    shared: { whoami: async (_input, _ctx, conn) => ({ user: conn.ctx.user, role: conn.role }) },
    user: {},
    admin: {
      secret: async (_input, ctx) => ({ data: `classified data for ${ctx.user}` }),
    },
  })

  await new Promise<void>((r) => server.listen(0, r))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  // admin token + admin role -> full surface
  const ada = createClient(api, { url, role: 'admin', params: { token: 'tok_ada' } })
  console.log('admin -> whoami:', await ada.whoami({}))
  console.log('admin -> secret:', await ada.secret({}))
  ada.close()

  // user token + user role -> `secret` isn't on the surface (compile error). Forced at runtime:
  const grace = createClient(api, { url, role: 'user', params: { token: 'tok_grace' } })
  console.log('user  -> whoami:', await grace.whoami({}))
  try {
    await (grace as unknown as { secret: (i: unknown) => Promise<unknown> }).secret({})
    console.log('user  -> secret: UNEXPECTEDLY succeeded')
  } catch (e) {
    const code = e instanceof SocketError ? e.code : 'ERROR'
    console.log(`user  -> secret: rejected (${code}) — not on the user role's surface`)
  }
  grace.close()

  // invalid token -> rejected at the upgrade (reconnect off so it surfaces immediately)
  const intruder = createClient(api, {
    url,
    role: 'user',
    params: { token: 'nope' },
    reconnect: false,
  })
  try {
    await intruder.whoami({})
    console.log('bad   -> UNEXPECTEDLY succeeded')
  } catch (e) {
    const code = e instanceof SocketError ? e.code : 'ERROR'
    console.log(`bad   -> rejected (${code}) — refused at the upgrade, no socket opened`)
  }
  intruder.close()

  await new Promise<void>((r) => server.close(() => r()))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
