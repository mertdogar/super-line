import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { jsonSerializer, INSPECTOR_SUBPROTOCOL, type Contract, type RoleOf } from '@super-line/core'
import {
  createSuperLineServer,
  type AuthResult,
  type SuperLineServerOptions,
  type SuperLineServer,
} from '@super-line/server'
import { createSuperLineClient, type SuperLineClient, type SuperLineClientOptions } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

// Spins up real loopback servers + clients and tears them down (clients first).
export function createHarness() {
  const cleanups: Array<() => Promise<void> | void> = []

  // Harness keeps `plugins` loosely typed (no P inference through this wrapper); compile-time handler
  // subtraction is asserted separately via a direct createSuperLineServer call in plugins.integration.test.ts.
  async function server<C extends Contract, A extends AuthResult<C>>(
    contract: C,
    opts: Omit<SuperLineServerOptions<C, A>, 'transports'>,
  ): Promise<{
    srv: SuperLineServer<C, A>
    http: http.Server
    url: string
  }> {
    const httpServer = http.createServer()
    const srv = createSuperLineServer<C, A, []>(contract, {
      // no `inspector` on the transport: the server declares the inspector reserved-connection class and the
      // transport negotiates from that (phase 2). Exercises the generalized reserved path, not the back-compat.
      ...opts,
      transports: [webSocketServerTransport({ server: httpServer })],
    } as unknown as SuperLineServerOptions<C, A, []>) // harness forgoes subtraction typing; plugins flow through at runtime
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
    opts: Omit<SuperLineClientOptions<C, R>, 'transport'> & { url: string },
  ): SuperLineClient<C, R> {
    const { url, ...rest } = opts
    const cl = createSuperLineClient(contract, {
      ...rest,
      transport: webSocketClientTransport({ url }),
    } as SuperLineClientOptions<C, R>)
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
  // message events (msg.*)
  target?: string
  name?: string
  input?: unknown
  output?: unknown
  data?: unknown
  ok?: boolean
  error?: { code: string; message: string }
  reqId?: number
  // collection / crdt events
  role?: string
  n?: string
  id?: string
  sid?: number
  op?: 'insert' | 'update' | 'delete'
  query?: unknown
  ops?: unknown
  row?: unknown
  count?: number
  origin?: string
  snapshot?: unknown
  deltaBytes?: number
}

export interface InspectorEnvelopeLike {
  event: InspectorEventLike
  ts: number
  byteSize?: number
  originNodeId: string
}

export interface Inspector {
  protocol: string
  request: (m: string, d?: unknown) => Promise<unknown>
  subscribeEvents: () => Promise<void>
  /** Unwrapped events (envelope `.event`), back-compat for assertions on event fields. */
  events: InspectorEventLike[]
  /** Full inspection records, for assertions on envelope metadata (ts/byteSize/originNodeId). */
  envelopes: InspectorEnvelopeLike[]
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
    const envelopes: InspectorEnvelopeLike[] = []
    ws.on('message', (data) => {
      const frame = jsonSerializer.decode(data as Buffer) as {
        t: string
        i: number
        c?: string
        d?: unknown
        code?: string
      }
      if (frame.t === 'pub' && frame.c === 'events') {
        const env = frame.d as InspectorEnvelopeLike
        envelopes.push(env)
        events.push(env.event)
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
        envelopes,
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
