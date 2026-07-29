/**
 * The libp2p adapter's on-topic framing, re-implemented.
 *
 * Every super-line channel rides ONE gossipsub topic, and the channel name is carried in a private
 * 3-byte-header envelope the adapter never exports. The mesh tap must decode it to attribute an arriving
 * frame to a channel — including the frames the adapter then discards, which are the whole point.
 *
 * This is a deliberate duplication pending sign-off on exporting the codec from `@super-line/adapter-libp2p`
 * (PLAN "Open decisions" #1). Duplication rots silently, so it does not get to fail silently:
 * `unframeChannel` throws unless the channel it decoded is one super-line could actually have produced.
 * If the adapter's framing ever changes, the lab stops with a decode error rather than quietly reporting
 * every frame as unattributed.
 */

const dec = new TextDecoder()

/** Channel prefixes the server can emit (`server/src/index.ts`), plus the adapter's private presence channel. */
const KNOWN_PREFIXES = ['r:', 't:', 'c:', 'u:', 'reply:', 'x:', 'd:']
const KNOWN_EXACT = ['cbatch', '\x00sl:presence']

export interface UnframedMessage {
  channel: string
  payload: string | Uint8Array
}

export function unframeChannel(data: Uint8Array): UnframedMessage {
  if (data.byteLength < 3) throw new Error(`traffic-lab codec: frame too short (${data.byteLength} bytes)`)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const chLen = view.getUint16(0)
  if (chLen + 3 > data.byteLength) throw new Error(`traffic-lab codec: channel length ${chLen} overruns the frame`)
  const channel = dec.decode(data.subarray(2, 2 + chLen))
  const body = data.subarray(3 + chLen)
  const payload = data[2 + chLen] === 0 ? dec.decode(body) : body
  if (!isKnownChannel(channel))
    throw new Error(
      `traffic-lab codec: decoded an unrecognized channel ${JSON.stringify(channel.slice(0, 40))} — ` +
        "the adapter's framing has probably changed; re-sync src/tap/codec.ts with adapter-libp2p",
    )
  return { channel, payload }
}

export function isKnownChannel(channel: string): boolean {
  return KNOWN_EXACT.includes(channel) || KNOWN_PREFIXES.some((p) => channel.startsWith(p))
}

/** Coarse bucket for reporting: `r:general` and `r:lobby` are one row, not two. */
export function channelClass(channel: string): string {
  if (channel === '\x00sl:presence') return 'presence'
  if (channel === 'cbatch') return 'cbatch'
  if (channel.startsWith('x:')) return channel.split(':').slice(0, 2).join(':') // x:inspector
  const prefix = KNOWN_PREFIXES.find((p) => channel.startsWith(p))
  return prefix ?? 'unknown'
}
