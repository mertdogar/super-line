import { Publisher, Subscriber } from 'zeromq'
import type { Adapter } from '@super-line/core'
import { createZeroMqAdapter, type ZeroMqPresenceOption } from '@super-line/adapter-zeromq'

export interface Cluster {
  adapters: Adapter[]
  dispose: () => Promise<void>
}

/**
 * Build `n` brokerless mesh adapters fully interconnected over loopback TCP.
 * PUBs bind to `:0` first (ZeroMQ holds the port immediately — race-free), then
 * each SUB connects to every other node's PUB via the BYO escape hatch.
 */
export async function makeCluster(n: number, presence?: ZeroMqPresenceOption): Promise<Cluster> {
  const pubs: Publisher[] = []
  const subs: Subscriber[] = []
  const adapters: Adapter[] = []
  const dispose = async (): Promise<void> => {
    for (const a of adapters) await a.close?.()
    for (const p of pubs) if (!p.closed) p.close()
    for (const s of subs) if (!s.closed) s.close()
  }
  try {
    for (let i = 0; i < n; i++) {
      const pub = new Publisher({ sendHighWaterMark: 100_000 })
      await pub.bind('tcp://127.0.0.1:0')
      pubs.push(pub)
    }
    const endpoints = pubs.map((p) => p.lastEndpoint as string)
    for (let i = 0; i < n; i++) {
      const sub = new Subscriber({ receiveHighWaterMark: 100_000 })
      endpoints.forEach((ep, j) => {
        if (j !== i) sub.connect(ep)
      })
      subs.push(sub)
      adapters.push(await createZeroMqAdapter({ pub: pubs[i]!, sub, presence }))
    }
    return { adapters, dispose }
  } catch (err) {
    await dispose()
    throw err
  }
}
