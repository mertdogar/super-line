import { Redis } from 'ioredis'
import type { Adapter, ConnDescriptor, NodeStat, PresenceStore } from '@super-line/core'

/** Options for {@link createRedisAdapter}. */
export interface RedisAdapterOptions {
  /** `redis://` connection URL (defaults to ioredis's default localhost:6379). */
  url?: string
  /**
   * How long a node's liveness key lives between heartbeats (ms). A node whose
   * key expires has its connections excluded from cluster queries. Must exceed
   * the server's heartbeat interval. Defaults to `90_000`.
   */
  presenceTtlMs?: number
}

const K_CONNS = 'sl:conns'
const kConn = (id: string) => `sl:conn:${id}`
const kNode = (n: string) => `sl:node:${n}`
const kAlive = (n: string) => `sl:alive:${n}`
const kUser = (u: string) => `sl:user:${u}`
const kRoom = (r: string) => `sl:room:${r}`

function redisPresence(pub: Redis, ttlMs: number): PresenceStore {
  async function read(ids: string[]): Promise<ConnDescriptor[]> {
    if (ids.length === 0) return []
    const raw = await pub.mget(ids.map(kConn))
    const ds: ConnDescriptor[] = []
    for (const s of raw) if (s) ds.push(JSON.parse(s) as ConnDescriptor)
    return liveOnly(ds)
  }
  async function liveOnly(ds: ConnDescriptor[]): Promise<ConnDescriptor[]> {
    const nodes = [...new Set(ds.map((d) => d.nodeId))]
    if (nodes.length === 0) return []
    const pipe = pub.pipeline()
    for (const n of nodes) pipe.exists(kAlive(n))
    const res = await pipe.exec()
    const alive = new Set<string>()
    nodes.forEach((n, i) => {
      if (res?.[i]?.[1] === 1) alive.add(n)
    })
    return ds.filter((d) => alive.has(d.nodeId))
  }
  async function del(connId: string): Promise<void> {
    const raw = await pub.get(kConn(connId))
    if (!raw) return
    const d = JSON.parse(raw) as ConnDescriptor
    const pipe = pub.pipeline()
    pipe.del(kConn(connId)).srem(K_CONNS, connId).srem(kNode(d.nodeId), connId)
    if (d.userId) pipe.srem(kUser(d.userId), connId)
    for (const r of d.rooms) pipe.srem(kRoom(r), connId)
    await pipe.exec()
  }

  return {
    async set(d) {
      const pipe = pub.pipeline()
      pipe.set(kConn(d.id), JSON.stringify(d)).sadd(K_CONNS, d.id).sadd(kNode(d.nodeId), d.id)
      if (d.userId) pipe.sadd(kUser(d.userId), d.id)
      for (const r of d.rooms) pipe.sadd(kRoom(r), d.id)
      pipe.set(kAlive(d.nodeId), '1', 'PX', ttlMs)
      await pipe.exec()
    },
    del,
    async beat(nodeId) {
      await pub.set(kAlive(nodeId), '1', 'PX', ttlMs)
    },
    async clearNode(nodeId) {
      const ids = await pub.smembers(kNode(nodeId))
      for (const id of ids) await del(id)
      await pub.pipeline().del(kNode(nodeId)).del(kAlive(nodeId)).exec()
    },
    async addRoom(connId, room) {
      const raw = await pub.get(kConn(connId))
      if (!raw) return
      const d = JSON.parse(raw) as ConnDescriptor
      if (d.rooms.includes(room)) return
      d.rooms.push(room)
      await pub.pipeline().set(kConn(connId), JSON.stringify(d)).sadd(kRoom(room), connId).exec()
    },
    async removeRoom(connId, room) {
      const raw = await pub.get(kConn(connId))
      if (!raw) return
      const d = JSON.parse(raw) as ConnDescriptor
      if (!d.rooms.includes(room)) return
      d.rooms = d.rooms.filter((r) => r !== room)
      await pub.pipeline().set(kConn(connId), JSON.stringify(d)).srem(kRoom(room), connId).exec()
    },
    async list() {
      return read(await pub.smembers(K_CONNS))
    },
    async get(connId) {
      return (await read([connId]))[0]
    },
    async byUser(userId) {
      return read(await pub.smembers(kUser(userId)))
    },
    async roomMembers(room) {
      return read(await pub.smembers(kRoom(room)))
    },
    async count() {
      return (await read(await pub.smembers(K_CONNS))).length
    },
    async topology() {
      const byNode = new Map<string, ConnDescriptor[]>()
      for (const d of await read(await pub.smembers(K_CONNS))) {
        const set = byNode.get(d.nodeId)
        if (set) set.push(d)
        else byNode.set(d.nodeId, [d])
      }
      const out: NodeStat[] = []
      for (const [nodeId, ds] of byNode) {
        out.push({
          nodeId,
          nodeName: ds[0]?.nodeName ?? nodeId,
          connections: ds.length,
          rooms: new Set(ds.flatMap((d) => d.rooms)).size,
          alive: true,
        })
      }
      return out
    },
  }
}

/**
 * Create a Redis Pub/Sub {@link Adapter} for multi-node fan-out. Pass the same
 * URL to every server process so rooms, topics, and the cluster event bus reach
 * clients and server subscribers on any node. Uses two connections (a subscriber
 * connection can't run
 * other commands); at-most-once delivery, matching the library's model.
 *
 * @param options - a `redis://` URL string or {@link RedisAdapterOptions}.
 * @example
 * ```ts
 * createSuperLineServer(api, { server, adapter: createRedisAdapter('redis://localhost:6379') })
 * ```
 */
export function createRedisAdapter(options: RedisAdapterOptions | string = {}): Adapter {
  const url = typeof options === 'string' ? options : options.url
  const ttlMs = (typeof options === 'string' ? undefined : options.presenceTtlMs) ?? 90_000
  const pub = url ? new Redis(url) : new Redis()
  // ready-check runs INFO, which is illegal once a connection enters subscriber mode;
  // disable it on the subscriber connection.
  const sub = pub.duplicate({ enableReadyCheck: false })
  // ioredis auto-reconnects; swallow transient 'error' events so they don't crash the process
  pub.on('error', () => {})
  sub.on('error', () => {})
  let handler: ((channel: string, payload: string | Uint8Array) => void) | undefined

  let closed = false

  // messageBuffer carries the raw bytes, preserving binary serializer output
  sub.on('messageBuffer', (channel: Buffer, payload: Buffer) => {
    handler?.(channel.toString(), payload)
  })

  return {
    async subscribe(channel) {
      await sub.subscribe(channel) // strict: failures surface to the subscribing client
    },
    async unsubscribe(channel) {
      if (closed) return
      try {
        await sub.unsubscribe(channel)
      } catch {
        // shutting down / disconnected — unsubscribe is best-effort
      }
    },
    async publish(channel, payload) {
      if (closed) return
      const message = typeof payload === 'string' ? payload : Buffer.from(payload)
      try {
        await pub.publish(channel, message)
      } catch {
        // at-most-once: a publish lost during a blip is acceptable
      }
    },
    onMessage(h) {
      handler = h
    },
    presence: redisPresence(pub, ttlMs),
    async close() {
      closed = true
      await Promise.allSettled([pub.quit(), sub.quit()])
    },
  }
}
