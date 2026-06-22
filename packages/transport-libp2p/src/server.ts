import type { Libp2p, Stream, Connection } from '@libp2p/interface'
import type { RawConn, ServerTransport, Handshake, AuthOutcome } from '@super-line/core'
import { wrap, decodeAuth, normalize, wireClose, makeWriter, pump, type Lp } from './framing.js'

const DEFAULT_PROTOCOL = '/super-line/1.0.0'

/** Options for {@link libp2pServerTransport}. */
export interface Libp2pServerTransportOptions {
  /** A started libp2p node (with a transport + noise + yamux). The transport registers a protocol handler on it; it does NOT create or stop the node. */
  node: Libp2p
  /** Protocol to handle. MUST match the client. Defaults to `/super-line/1.0.0`. */
  protocol?: string
}

/** A libp2p server transport: handles an inbound protocol stream per connection, authenticating via its first frame. */
export function libp2pServerTransport(opts: Libp2pServerTransportOptions): ServerTransport {
  const protocol = opts.protocol ?? DEFAULT_PROTOCOL
  const live = new Set<Stream>()
  let hooks: Parameters<ServerTransport['start']>[0] | undefined
  let stopped = false

  async function handler(stream: Stream, connection: Connection): Promise<void> {
    const lp = wrap(stream)
    let auth: AuthOutcome
    try {
      const first = await lp.read()
      const { role, params } = decodeAuth(first.subarray())
      const handshake: Handshake = {
        transport: 'libp2p',
        headers: {},
        query: { role, ...params },
        peer: { id: connection.remotePeer.toString(), addr: connection.remoteAddr.toString() },
        raw: connection,
      }
      auth = await hooks!.authenticate(handshake)
    } catch {
      stream.abort(new Error('unauthorized')) // bad handshake / rejected auth -> client sees onClose(1006)
      return
    }
    if (stopped) {
      stream.abort(new Error('server stopped'))
      return
    }
    live.add(stream)
    stream.addEventListener('close', () => live.delete(stream))
    hooks!.onConnection(serverRawConn(stream, lp), auth)
  }

  return {
    async start(h) {
      hooks = h
      await opts.node.handle(protocol, (stream, connection) => void handler(stream, connection), { force: true })
    },
    async stop() {
      stopped = true
      await opts.node.unhandle(protocol)
      for (const stream of live) stream.abort(new Error('server stopped'))
    },
  }
}

function serverRawConn(stream: Stream, lp: Lp): RawConn {
  const write = makeWriter(lp)
  return {
    get writable() {
      // liveness only (parity with ws/loopback): backpressure is buffered by makeWriter -> lp.write, not dropped
      return stream.writeStatus === 'writable'
    },
    send(bytes) {
      if (stream.writeStatus !== 'writable') return
      write(normalize(bytes))
    },
    onMessage(cb) {
      pump(lp, cb) // frame 1 (auth) was already consumed in the handler; the pump reads frames 2..N
    },
    onClose(cb) {
      wireClose(stream, cb)
    },
    onDrain(cb) {
      stream.addEventListener('drain', () => cb())
    },
    close() {
      void stream.close()
    },
    terminate() {
      stream.abort(new Error('terminate'))
    },
  }
}
