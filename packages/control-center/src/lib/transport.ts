/** Transport (wire) helpers — the first-class wire dimension, mirroring `roleColor`. */

/** The 4 wire families the UI groups by (HTTP collapses its sse/longpoll sub-modes). */
export type TransportFamily = 'websocket' | 'http' | 'libp2p' | 'loopback' | 'unknown'

/** Map a raw wire id (incl. the HTTP sub-modes) to its family. */
export function transportFamily(transport: string | undefined): TransportFamily {
  switch (transport) {
    case 'websocket':
      return 'websocket'
    case 'sse':
    case 'longpoll':
      return 'http'
    case 'libp2p':
      return 'libp2p'
    case 'loopback':
      return 'loopback'
    default:
      return 'unknown'
  }
}

/** A friendly label for a raw wire id, e.g. `'HTTP · SSE'`. Falls through to the raw id for unknowns. */
export function transportLabel(transport: string | undefined): string {
  switch (transport) {
    case 'websocket':
      return 'WebSocket'
    case 'sse':
      return 'HTTP · SSE'
    case 'longpoll':
      return 'HTTP · long-poll'
    case 'libp2p':
      return 'libp2p'
    case 'loopback':
      return 'Loopback'
    case undefined:
      return 'unknown'
    default:
      return transport
  }
}

/** Short family token for lens counts + per-node breakdown, e.g. `'ws'`, `'http'`. */
export function familyShort(family: TransportFamily): string {
  return family === 'websocket' ? 'ws' : family
}

// fixed, legible per-family palette (loopback/unknown muted — the test/absent wire)
const TRANSPORT_COLORS: Record<TransportFamily, string> = {
  websocket: '#22d3ee',
  http: '#a78bfa',
  libp2p: '#34d399',
  loopback: '#64748b',
  unknown: '#64748b',
}

/** Stable color for a wire family. */
export function familyColor(family: TransportFamily): string {
  return TRANSPORT_COLORS[family]
}

/** Stable color for a raw wire id, keyed by family. */
export function transportColor(transport: string | undefined): string {
  return familyColor(transportFamily(transport))
}

/** Families present across the given connections, with counts, busiest first (for the lens). */
export function transportsOf(conns: { transport?: string }[]): { family: TransportFamily; count: number }[] {
  const counts = new Map<TransportFamily, number>()
  for (const c of conns) {
    const f = transportFamily(c.transport)
    counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family))
}

/** A compact per-node wire breakdown, e.g. `'3 ws / 2 http'`. Empty string for no connections. */
export function breakdownLabel(conns: { transport?: string }[]): string {
  return transportsOf(conns)
    .map(({ family, count }) => `${count} ${familyShort(family)}`)
    .join(' / ')
}
