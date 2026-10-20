import { defineContract } from '@super-line/core'
import type { ClientTransport, RawConn } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { remoteRowsCollection } from '@super-line/collections-cloudflare/contract'
import * as z from 'zod'

// The app the hibernation tests run: one topic, and requests to publish on it, to flip a lock the
// subscribe guard reads from storage, and to round-trip; one row collection and one CRDT document
// collection on the object's SQLite, with a request to create a document (creation is server-side).
export const appContract = defineContract({
  collections: {
    notes: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' },
    boards: { schema: z.object({ title: z.string() }), crdt: { mode: 'document' } },
  },
  roles: {
    user: {
      clientToServer: {
        ping: { input: z.object({ n: z.number() }), output: z.object({ n: z.number() }) },
        shout: { input: z.object({ msg: z.string() }), output: z.null() },
        lock: { input: z.void(), output: z.null() },
        createBoard: { input: z.object({ id: z.string(), title: z.string() }), output: z.null() },
      },
      serverToClient: {
        announce: { payload: z.object({ msg: z.string() }), subscribe: true },
      },
    },
  },
})

/** A node running plugin-auth: one request, so a signed-in client has something to send. */
export const authApp = defineContract({
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.null() } } } },
  plugins: [authContract()],
})

/** A node serving its sources' tables as `storeRows`, beside a row collection of its own. */
export const rowsContract = defineContract({
  collections: { notes: { schema: z.object({ id: z.string(), text: z.string() }), key: 'id' } },
  roles: { user: { clientToServer: { ping: { input: z.void(), output: z.null() } } } },
  plugins: [remoteRowsCollection('storeRows')],
})

const enc = new TextEncoder()

/** A client transport that dials a Durable Object stub directly — a browser would dial the Worker URL instead. */
export function stubTransport(stub: DurableObjectStub): ClientTransport {
  return {
    connect(params, hooks) {
      let ws: WebSocket | undefined
      const raw: RawConn = {
        get writable() {
          return ws?.readyState === WebSocket.OPEN
        },
        send: (bytes) => ws?.send(bytes),
        close: (code = 1000, reason) => ws?.close(code, reason),
        terminate: () => ws?.close(1011, 'terminated'),
        onMessage() {},
        onClose() {},
        onDrain() {},
      }
      stub.fetch(`https://node/?${new URLSearchParams(params)}`, { headers: { Upgrade: 'websocket' } }).then(
        (res) => {
          if (!res.webSocket) return hooks.onClose(1006)
          ws = res.webSocket
          ws.accept()
          ws.addEventListener('message', (e) => hooks.onMessage(typeof e.data === 'string' ? enc.encode(e.data) : new Uint8Array(e.data as ArrayBuffer)))
          ws.addEventListener('close', (e) => hooks.onClose(e.code))
          hooks.onOpen()
        },
        () => hooks.onClose(1006),
      )
      return raw
    },
  }
}
