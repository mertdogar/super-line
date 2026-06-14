import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { SocketError } from '@super-line/core'
import { createSocketServer } from '@super-line/server'
import { createClient } from '@super-line/client'
import { api } from './contract.js'

// Pretend token store. In a real app, verify a JWT / session here instead.
const TOKENS: Record<string, string> = { tok_ada: 'ada', tok_grace: 'grace' }

function verifyToken(token: string | null): string {
  const user = token ? TOKENS[token] : undefined
  if (!user) throw new SocketError('UNAUTHORIZED', 'invalid token')
  return user
}

async function main(): Promise<void> {
  const server = http.createServer()
  const srv = createSocketServer(api, {
    server,
    // runs at the HTTP upgrade — throw to reject with 401 before a socket is opened
    authenticate: (req) => {
      const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token')
      return { user: verifyToken(token) }
    },
  })

  srv.implement({
    whoami: async (_input, ctx) => ({ user: ctx.user }),
    secret: async (_input, ctx) => ({ data: `classified data for ${ctx.user}` }),
  })

  await new Promise<void>((r) => server.listen(0, r))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`

  // valid token -> authorized
  const ada = createClient(api, { url, params: { token: 'tok_ada' } })
  console.log('good token -> whoami:', await ada.whoami({}))
  console.log('good token -> secret:', await ada.secret({}))
  ada.close()

  // invalid token -> rejected at the upgrade (reconnect off so it surfaces immediately)
  const intruder = createClient(api, { url, params: { token: 'nope' }, reconnect: false })
  try {
    await intruder.whoami({})
    console.log('bad token  -> UNEXPECTEDLY succeeded')
  } catch (e) {
    const code = e instanceof SocketError ? e.code : 'ERROR'
    console.log(`bad token  -> rejected (${code}) — refused at the upgrade, no socket opened`)
  }
  intruder.close()

  await new Promise<void>((r) => server.close(() => r()))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
