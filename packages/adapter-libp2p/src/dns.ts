import { lookup } from 'node:dns/promises'
import type { Connection, Libp2p } from '@libp2p/interface'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'

export interface DnsDiscoveryInit {
  /** DNS hostname whose A/AAAA records identify peers (for example, a Kubernetes headless Service). */
  hostname: string
  /** TCP port every discovered peer listens on. */
  port: number
  /** How often to resolve and dial newly-added endpoints. Defaults to 5_000. */
  intervalMs?: number
}

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>

type DialNode = Pick<Libp2p, 'dial' | 'getMultiaddrs'>

const systemResolver: DnsResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true })
  return records.flatMap(({ address, family }) => (family === 4 || family === 6 ? [{ address, family }] : []))
}

const isSelf = (target: string, own: Multiaddr[]): boolean =>
  own.some((addr) => addr.toString() === target || addr.toString().startsWith(`${target}/p2p/`))

export async function dialDnsPeers(
  node: DialNode,
  options: DnsDiscoveryInit,
  connections: Map<string, Connection>,
  resolve: DnsResolver = systemResolver,
): Promise<void> {
  const records = await resolve(options.hostname)
  const own = node.getMultiaddrs()
  const targets = new Map<string, Multiaddr>()
  for (const { address, family } of records) {
    const target = multiaddr(`/ip${family}/${address}/tcp/${options.port}`)
    targets.set(target.toString(), target)
  }
  for (const key of connections.keys()) {
    if (!targets.has(key)) connections.delete(key)
  }

  await Promise.all(
    [...targets].map(async ([key, target]) => {
      if (isSelf(key, own) || connections.get(key)?.status === 'open') return
      try {
        connections.set(key, await node.dial(target, { signal: AbortSignal.timeout(5_000) }))
      } catch {
        connections.delete(key)
      }
    }),
  )
}

export function startDnsDiscovery(
  node: DialNode,
  options: DnsDiscoveryInit,
  resolve: DnsResolver = systemResolver,
): () => void {
  const connections = new Map<string, Connection>()
  let stopped = false
  let running = false

  const scan = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      await dialDnsPeers(node, options, connections, resolve)
    } catch {
      // DNS is eventually consistent; the next interval retries.
    } finally {
      running = false
    }
  }

  void scan()
  const timer = setInterval(() => void scan(), options.intervalMs ?? 5_000)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
