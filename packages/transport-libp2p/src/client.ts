import type { Libp2p, Stream, DialTarget } from '@libp2p/interface'
import type { RawConn, ClientTransport } from '@super-line/core'
import { wrap, encodeAuth, normalize, wireClose, makeWriter, pump } from './framing.js'

const DEFAULT_PROTOCOL = '/super-line/1.0.0'

/** Options for {@link libp2pClientTransport}. */
export interface Libp2pClientTransportOptions {
  /** A started libp2p node configured to dial the server's transport. */
  node: Libp2p
  /** The server's dial target — a `Multiaddr`/`Multiaddr[]` (e.g. `serverNode.getMultiaddrs()`) or a `PeerId`. */
  multiaddr: DialTarget
  /** MUST match the server. Defaults to `/super-line/1.0.0`. */
  protocol?: string
  /** Dial timeout in ms. Defaults to `10_000`. */
  dialTimeoutMs?: number
}

/** A libp2p client transport: dials the protocol, sends the first auth frame, then carries wire frames. */
export function libp2pClientTransport(opts: Libp2pClientTransportOptions): ClientTransport {
  const protocol = opts.protocol ?? DEFAULT_PROTOCOL
  const dialTimeoutMs = opts.dialTimeoutMs ?? 10_000

  return {
    connect(handshakeParams, hooks) {
      const { role = '', ...params } = handshakeParams
      let stream: Stream | undefined
      let write: ((bytes: Uint8Array) => void) | undefined
      let closed = false
      let pending: 'close' | 'terminate' | undefined

      function fireClose(code: number): void {
        if (closed) return
        closed = true
        hooks.onClose(code)
      }

      void (async () => {
        let s: Stream
        try {
          s = await opts.node.dialProtocol(opts.multiaddr, protocol, { signal: AbortSignal.timeout(dialTimeoutMs) })
        } catch {
          fireClose(1006) // server down / bad addr / dial aborted
          return
        }
        if (closed || pending) {
          if (pending === 'terminate') s.abort(new Error('terminate'))
          else void s.close()
          return
        }
        const lp = wrap(s)
        stream = s
        write = makeWriter(lp)
        wireClose(s, fireClose)
        s.addEventListener('drain', () => hooks.onDrain())
        try {
          await lp.write(encodeAuth({ role, params })) // frame 1: auth
        } catch {
          fireClose(1006)
          return
        }
        if (closed || pending) {
          // close()/terminate() landed during the auth-write await — never fire onOpen after onClose
          if (pending === 'terminate') s.abort(new Error('terminate'))
          else void s.close()
          return
        }
        hooks.onOpen()
        pump(lp, hooks.onMessage)
      })()

      return {
        get writable() {
          return !closed && stream !== undefined && stream.writeStatus === 'writable'
        },
        send(bytes) {
          if (closed || !stream || !write || stream.writeStatus !== 'writable') return
          write(normalize(bytes))
        },
        onMessage() {}, // client core uses the hooks passed to connect()
        onClose() {},
        onDrain() {},
        close() {
          if (closed) return
          if (stream) void stream.close()
          else pending = 'close' // close before the dial resolved — abort the stream when it arrives
          fireClose(1000)
        },
        terminate() {
          if (closed) return
          if (stream) stream.abort(new Error('terminate'))
          else pending = 'terminate'
          fireClose(1006)
        },
      } satisfies RawConn
    },
  }
}
