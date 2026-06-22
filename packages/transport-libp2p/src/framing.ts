import { lpStream, type LengthPrefixedStream } from '@libp2p/utils'
import type { Stream, StreamCloseEvent } from '@libp2p/interface'

/** A length-prefixed view over a libp2p stream. One write/read == one logical frame, regardless of yamux chunking. */
export type Lp = LengthPrefixedStream<Stream>

export function wrap(stream: Stream): Lp {
  return lpStream(stream)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The first frame on every stream: the libp2p analogue of the WS transport's `?role=…&token=…` query. */
export interface AuthFrame {
  role: string
  params: Record<string, string>
}

export function encodeAuth(auth: AuthFrame): Uint8Array {
  return encoder.encode(JSON.stringify(auth))
}

export function decodeAuth(bytes: Uint8Array): AuthFrame {
  const obj = JSON.parse(decoder.decode(bytes)) as Partial<AuthFrame>
  return { role: obj.role ?? '', params: obj.params ?? {} }
}

export function normalize(frame: string | Uint8Array): Uint8Array {
  return typeof frame === 'string' ? encoder.encode(frame) : frame
}

/** Any close carrying an error (abort / remote reset) is abnormal (1006); a clean close is graceful (1000). */
export function codeFromCloseEvent(evt: StreamCloseEvent): number {
  return evt.error ? 1006 : 1000
}

/**
 * Surface a single logical close. `'close'` fires on a full close/reset (with `.error` on abort);
 * a graceful peer `stream.close()` only half-closes, so the peer sees `'remoteCloseWrite'` — treat
 * that as a graceful close (1000) and reciprocate to fully tear the stream down. Fires `onClose` once.
 */
export function wireClose(stream: Stream, onClose: (code: number) => void): void {
  let fired = false
  const fire = (code: number): void => {
    if (fired) return
    fired = true
    onClose(code)
  }
  stream.addEventListener('close', (evt) => fire(codeFromCloseEvent(evt)))
  stream.addEventListener('remoteCloseWrite', () => {
    fire(1000)
    void stream.close().catch(() => {})
  })
  // the one-shot 'close' may have already fired before we attached (e.g. a reset during `await authenticate`)
  if (stream.status === 'aborted' || stream.status === 'reset') fire(1006)
  else if (stream.status === 'closed') fire(1000)
}

/**
 * A serialized writer over `lp`: every `send` is chained onto the previous write's promise so concurrent
 * sends can never interleave a length prefix with another frame's body on the wire.
 */
export function makeWriter(lp: Lp): (bytes: Uint8Array) => void {
  let chain: Promise<void> = Promise.resolve()
  return (bytes) => {
    chain = chain.then(() => lp.write(bytes)).catch(() => {
      /* write rejects when the stream is gone; the 'close' listener surfaces the logical close */
    })
  }
}

/** Pull→push bridge: read length-prefixed frames until the stream closes (read rejects), then stop. */
export function pump(lp: Lp, onMessage: (bytes: Uint8Array) => void): void {
  void (async () => {
    try {
      for (;;) {
        const data = await lp.read()
        try {
          onMessage(data.subarray())
        } catch {
          /* a buggy app handler must not stop the read loop or be mistaken for a stream close */
        }
      }
    } catch {
      /* lp.read rejects when the stream closes/resets — the 'close' listener fires onClose */
    }
  })()
}
