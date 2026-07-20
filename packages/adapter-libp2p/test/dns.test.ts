import { describe, expect, it, vi } from 'vitest'
import type { Connection, Libp2p } from '@libp2p/interface'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { dialDnsPeers } from '../src/dns.js'

describe('DNS discovery', () => {
  it('dials newly-added A/AAAA endpoints, skips self, and keeps live connections', async () => {
    const dial = vi.fn(async (_target: Multiaddr) => ({ status: 'open' }) as Connection)
    const node = {
      dial,
      getMultiaddrs: () => [multiaddr('/ip4/10.0.0.1/tcp/9001')],
    } as unknown as Pick<Libp2p, 'dial' | 'getMultiaddrs'>
    const connections = new Map<string, Connection>()
    let scan = 0
    const resolve = vi.fn(async () => {
      scan += 1
      return scan === 1
        ? [
            { address: '10.0.0.1', family: 4 as const },
            { address: '10.0.0.2', family: 4 as const },
            { address: '10.0.0.2', family: 4 as const },
          ]
        : [
            { address: '10.0.0.1', family: 4 as const },
            { address: '10.0.0.2', family: 4 as const },
            { address: 'fd00::3', family: 6 as const },
          ]
    })

    await dialDnsPeers(node, { hostname: 'super-line-p2p', port: 9001 }, connections, resolve)
    await dialDnsPeers(node, { hostname: 'super-line-p2p', port: 9001 }, connections, resolve)

    expect(dial.mock.calls.map(([addr]) => addr.toString()).sort()).toEqual([
      '/ip4/10.0.0.2/tcp/9001',
      '/ip6/fd00::3/tcp/9001',
    ])
  })
})
