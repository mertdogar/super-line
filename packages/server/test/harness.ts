import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { jsonSerializer, INSPECTOR_SUBPROTOCOL, type Contract, type RoleOf } from '@super-line/core'
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

export interface InspectorEventLike {
  type: string
  descriptor?: { id: string; role: string; nodeId: string }
  connId?: string
  room?: string
  topic?: string
}

export interface Inspector {
  protocol: string
  request: (m: string, d?: unknown) => Promise<unknown>
  subscribeEvents: () => Promise<void>
  events: InspectorEventLike[]
  close: () => void
}

// A minimal raw-ws inspector client (the typed client ships in @super-line/control-center):
// connects with the reserved subprotocol, sends req/sub frames, resolves on the matching
// res/err, and collects pub frames pushed on the `events` topic.
export function connectInspector(url: string): Promise<Inspector> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, INSPECTOR_SUBPROTOCOL)
    let id = 1
    const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
    const events: InspectorEventLike[] = []
    ws.on('message', (data) => {
      const frame = jsonSerializer.decode(data as Buffer) as {
        t: string
        i: number
        c?: string
        d?: unknown
        code?: string
      }
      if (frame.t === 'pub' && frame.c === 'events') {
        events.push(frame.d as InspectorEventLike)
        return
      }
      const w = waiters.get(frame.i)
      if (!w) return
      waiters.delete(frame.i)
      if (frame.t === 'res') w.resolve(frame.d)
      else if (frame.t === 'err') w.reject(new Error(frame.code))
    })
    const sendFrame = (frame: Record<string, unknown>): Promise<unknown> =>
      new Promise((res, rej) => {
        const i = id++
        waiters.set(i, { resolve: res, reject: rej })
        ws.send(jsonSerializer.encode({ ...frame, i }))
      })
    ws.on('open', () =>
      resolve({
        protocol: ws.protocol,
        request: (m, d) => sendFrame({ t: 'req', m, d }),
        subscribeEvents: () => sendFrame({ t: 'sub', c: 'events' }).then(() => undefined),
        events,
        close: () => ws.close(),
      }),
    )
    ws.on('error', reject)
  })
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
