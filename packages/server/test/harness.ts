import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Contract } from '@super-line/core'
import { createSocketServer, type ServerOptions, type SocketServer } from '@super-line/server'
import { createClient, type Client, type ClientOptions } from '@super-line/client'

// Spins up real loopback servers + clients and tears them down (clients first).
export function createHarness() {
  const cleanups: Array<() => Promise<void> | void> = []

  async function server<Ctx>(opts: Omit<ServerOptions<Ctx>, 'server'> = {}): Promise<{
    srv: SocketServer<Ctx>
    http: http.Server
    url: string
  }> {
    const httpServer = http.createServer()
    const srv = createSocketServer<Ctx>({ ...opts, server: httpServer })
    await new Promise<void>((resolve) => httpServer.listen(0, resolve))
    const { port } = httpServer.address() as AddressInfo
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())))
    return { srv, http: httpServer, url: `ws://127.0.0.1:${port}` }
  }

  function client<C extends Contract>(contract: C, opts: ClientOptions): Client<C> {
    const c = createClient(contract, opts)
    cleanups.unshift(() => c.close()) // clients close before the servers they connect to
    return c
  }

  async function dispose(): Promise<void> {
    for (const fn of cleanups.splice(0)) await fn()
  }

  return { server, client, dispose }
}
