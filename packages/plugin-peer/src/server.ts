import { SuperLineError, validateSync } from '@super-line/core'
import type { ConnDescriptor } from '@super-line/core'
import type { Conn, SuperLinePlugin } from '@super-line/server'
import { peerHash, peerSurface } from './index.js'
import type { PeerInfo, PeerSelf, PeerSurface } from './index.js'

type Awaitable<T> = T | Promise<T>

const OWNER_ROOM = 'peer-owner:'
const joinRequestSchema = peerSurface.serverToClient['peer.joinRequest'].payload

export interface PeerServerOptions<Ctx = unknown> {
  /** Who may create a room. Deny-by-default: a missing hook or `false` rejects with `FORBIDDEN`. */
  authorizeCreate: (args: { creator: ConnDescriptor; ctx: Ctx }) => Awaitable<boolean>
  /**
   * Who may ask to join `roomKey`. Deny-by-default. `{ info }` is a host-chosen public descriptor the
   * server stamps into the join request, so the creator decides on attested identity.
   */
  authorize: (args: { joiner: ConnDescriptor; roomKey: string; ctx: Ctx }) => Awaitable<boolean | { info?: PeerInfo }>
  /** Rooms one connection may own at once (default 8). */
  maxRoomsPerConn?: number
}

const selfOf = (conn: Conn): PeerSelf => ({ connId: conn.id, role: conn.role })

/**
 * The server half of the peer plugin: admission and signaling for direct client-to-client rooms.
 * It keeps no state: owner authority is the `ownerSecret` itself, and the only footprint is one
 * server room per peer room (the mailbox for join requests).
 */
export function peer<Ctx = unknown>(opts: PeerServerOptions<Ctx>): { plugin: SuperLinePlugin<PeerSurface> } {
  const maxRooms = opts.maxRoomsPerConn ?? 8
  return {
    plugin: {
      name: 'peer',
      handlers: (sl) => ({
        peerCreateRoom: async ({ ownerSecret }, ctx, conn) => {
          const roomKey = await peerHash(ownerSecret)
          const ownerRoom = OWNER_ROOM + (await peerHash(roomKey))
          const allowed = opts.authorizeCreate
            ? await opts.authorizeCreate({ creator: sl.describe(conn), ctx: ctx as Ctx })
            : false
          if (!allowed) throw new SuperLineError('FORBIDDEN', 'Room creation denied')
          const rooms = sl.describe(conn).rooms
          if (!rooms.includes(ownerRoom) && rooms.filter((r) => r.startsWith(OWNER_ROOM)).length >= maxRooms) {
            throw new SuperLineError('FORBIDDEN', `A connection may own at most ${maxRooms} rooms`)
          }
          await sl.room(ownerRoom).add(conn)
          if (!conn.raw.writable) sl.room(ownerRoom).remove(conn)
          return { roomKey, self: selfOf(conn) }
        },
        peerCloseRoom: async ({ ownerSecret }, _ctx, conn) => {
          sl.room(OWNER_ROOM + (await peerHash(await peerHash(ownerSecret)))).remove(conn)
          return {}
        },
        peerJoin: async ({ roomKey, ticket }, ctx, conn) => {
          const verdict = opts.authorize
            ? await opts.authorize({ joiner: sl.describe(conn), roomKey, ctx: ctx as Ctx })
            : false
          if (!verdict) throw new SuperLineError('FORBIDDEN', 'Join denied')
          const keyHash = await peerHash(roomKey)
          const info = verdict === true ? undefined : verdict.info
          const request = validateSync(joinRequestSchema, {
            keyHash,
            ticket,
            joiner: { ...selfOf(conn), ...(info !== undefined ? { info } : {}) },
          })
          sl.room(OWNER_ROOM + keyHash).broadcast('peer.joinRequest', request)
          return { self: selfOf(conn) }
        },
        peerAdmit: async ({ ownerSecret, joiner, accept, members }, _ctx, conn) => {
          const roomKey = await peerHash(ownerSecret)
          sl.toConn(joiner.connId).emit('peer.admitted', {
            roomKey,
            accept,
            by: selfOf(conn),
            members: accept ? members : [],
          })
          if (accept) for (const m of members) sl.toConn(m.connId).emit('peer.joined', { roomKey, member: joiner })
          return {}
        },
        peerRemove: async ({ ownerSecret, member, members }) => {
          const roomKey = await peerHash(ownerSecret)
          for (const id of new Set([...members, member])) sl.toConn(id).emit('peer.left', { roomKey, member })
          return {}
        },
        peerSignal: async ({ to, ...body }, _ctx, conn) => {
          sl.toConn(to).emit('peer.signal', { ...body, from: selfOf(conn) })
          return {}
        },
      }),
    },
  }
}
