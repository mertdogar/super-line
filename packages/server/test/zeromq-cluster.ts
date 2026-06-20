import { Publisher, Subscriber } from 'zeromq'
import type { Adapter } from '@super-line/core'
import { createZeroMqAdapter, createZeroMqProxy, type ZeroMqPresenceOption, type ZeroMqProxy } from '@super-line/adapter-zeromq'

export interface Cluster {
  adapters: Adapter[]
  dispose: () => Promise<void>
}

export interface ProxyCluster extends Cluster {
  proxy: ZeroMqProxy
}

/** Build `n` adapters that fan out through a central XSUB⇄XPUB forwarder (mode: 'proxy'). */
export async function makeProxyCluster(n: number, presence?: ZeroMqPresenceOption): Promise<ProxyCluster> {
  const proxy = await createZeroMqProxy({ frontendUrl: 'tcp://127.0.0.1:0', backendUrl: 'tcp://127.0.0.1:0' })
  const adapters: Adapter[] = []
  const dispose = async (): Promise<void> => {
    for (const a of adapters) await a.close?.()
    await proxy.stop()
  }
  try {
    for (let i = 0; i < n; i++) {
      adapters.push(
        await createZeroMqAdapter({ mode: 'proxy', frontendUrl: proxy.frontendUrl, backendUrl: proxy.backendUrl, presence }),
      )
    }
    return { adapters, dispose, proxy }
  } catch (err) {
    await dispose()
    throw err
  }
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
    // Let ZeroMQ establish the mesh connections + propagate the PRESENCE_CHANNEL subscriptions
    // before any test runs. Without this slow-joiner settle, the first presence delta (sent when
    // a client connects, right after this returns) can be dropped before the mesh is ready.
    await new Promise((r) => setTimeout(r, 300))
    return { adapters, dispose }
  } catch (err) {
    await dispose()
    throw err
  }
}
