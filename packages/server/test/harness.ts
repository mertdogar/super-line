import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Contract, RoleOf } from '@super-line/core'
import {
  createSocketServer,
  type AuthResult,
  type ServerOptions,
  type SocketServer,
} from '@super-line/server'
import { createClient, type Client, type ClientOptions } from '@super-line/client'

// Spins up real loopback servers + clients and tears them down (clients first).
export function createHarness() {
  const cleanups: Array<() => Promise<void> | void> = []

  async function server<C extends Contract, A extends AuthResult<C>>(
    contract: C,
    opts: Omit<ServerOptions<C, A>, 'server'>,
  ): Promise<{
    srv: SocketServer<C, A>
    http: http.Server
    url: string
  }> {
    const httpServer = http.createServer()
    const srv = createSocketServer<C, A>(contract, { ...opts, server: httpServer })
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    const { port } = httpServer.address() as AddressInfo
    cleanups.push(async () => {
      await srv.close() // closes conns, wss, and the adapter (e.g. redis connections)
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    })
    return { srv, http: httpServer, url: `ws://127.0.0.1:${port}` }
  }

  function client<C extends Contract, R extends RoleOf<C>>(
    contract: C,
    opts: ClientOptions<C, R>,
  ): Client<C, R> {
    const cl = createClient(contract, opts)
    cleanups.unshift(() => cl.close()) // clients close before the servers they connect to
    return cl
  }

  async function dispose(): Promise<void> {
    for (const fn of cleanups.splice(0)) await fn()
  }

  return { server, client, dispose }
}

export const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeout = 2000,
): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await tick(5)
  }
}
