import * as z from 'zod'
import { getLogger } from '@logtape/logtape'
import { jsonSerializer, SuperLineError, validateSync } from '@super-line/core'
import type { Contract, RoleOf, Serializer } from '@super-line/core'
import type { SuperLineClient } from '@super-line/client'
import { peerHash, peerSecret, peerSurface } from './index.js'
import type {
  PeerAdmitted,
  PeerChannelName,
  PeerChannels,
  PeerIceCandidate,
  PeerInfo,
  PeerJoined,
  PeerJoinRequest,
  PeerLeft,
  PeerMessageIn,
  PeerMessageOut,
  PeerSelf,
  PeerSignal,
} from './index.js'

type Awaitable<T> = T | Promise<T>
type Timer = ReturnType<typeof setTimeout>

const log = getLogger(['super-line', 'plugin-peer', 'client'])

const MAX_ROOM_MEMBERS = 33
const ADMISSION_QUEUE = 8
const HELD_PER_SENDER = 32
const HELD_PER_KEY = MAX_ROOM_MEMBERS * HELD_PER_SENDER
const HELD_BYTES_PER_KEY = 524_288
const EARLY_MESSAGES = 64
const PENDING_CANDIDATES = 64
const FALLBACK_MAX_MESSAGE = 65_536
const CLOSE_GRACE_MS = 1_000

const stc = peerSurface.serverToClient
const helloSchema = z.strictObject({ t: z.literal('hello'), from: z.string(), to: z.string(), roomKey: z.string() })
const encoder = new TextEncoder()

export type PeerLinkState = 'connecting' | 'open' | 'failed'

/** A room member as this client sees it. `link` is the state of this client's direct link to it. */
export interface PeerRoomMember {
  readonly id: string
  readonly role?: string
  readonly info?: PeerInfo
  readonly link: PeerLinkState
}

export interface PeerMemberEvent {
  type: 'joined' | 'left' | 'link'
  member: PeerRoomMember
}

/** `refused`: a re-join was denied. `lost`: a re-join ran out of attempts. `ended`: the creator left or closed. */
export type PeerCloseReason = 'left' | 'kicked' | 'closed' | 'refused' | 'lost' | 'ended'

/** `rejoining` while a joined room re-joins after a reconnect or after losing its link to the creator. */
export type PeerRoomState = 'active' | 'rejoining' | 'closed'

export interface PeerEventTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** The slice of `document` the peer client listens on: `visibilitychange` here, `pagehide` on `defaultView`. */
export interface PeerDocument extends PeerEventTarget {
  readonly visibilityState: string
  readonly defaultView?: PeerEventTarget | null
}

/** What the creator's `accept` sees: the server-verified id and role, plus the host's `authorize` info. */
export interface PeerJoiner {
  id: string
  role: string
  info?: PeerInfo
}

export interface PeerChannel<In, Out> {
  /** Send to every member whose link is open. Never throws because one link is not ready. */
  send(message: In): void
  to(memberId: string): { send(message: In): void }
  /** Receive validated messages; `from` is the member whose link carried it. Returns an unsubscribe. */
  on(handler: (message: Out, from: PeerRoomMember) => void): () => void
}

export interface PeerRoom<Ch extends PeerChannels = PeerChannels> {
  /** The room key: share it (QR code, link) with whoever should be able to ask to join. */
  readonly key: string
  readonly self: { id: string; role: string }
  readonly members: PeerRoomMember[]
  readonly state: PeerRoomState
  onState(cb: (state: PeerRoomState) => void): () => void
  onMember(cb: (event: PeerMemberEvent) => void): () => void
  channel<N extends PeerChannelName<Ch>>(name: N): PeerChannel<PeerMessageIn<Ch, N>, PeerMessageOut<Ch, N>>
  /** Creator only: remove a member everywhere and forget its ticket. */
  kick(memberId: string): Promise<void>
  leave(): void
  onClose(cb: (reason: PeerCloseReason) => void): () => void
}

export interface PeerCreateRoomOptions {
  /** Decide on each join request. Deny-by-default: a falsy result or a throw rejects. */
  accept: (joiner: PeerJoiner) => Awaitable<boolean>
  /** Room size including the creator (2..33, default 33). */
  maxMembers?: number
}

export interface PeerErrorInfo<Ch extends PeerChannels = PeerChannels> {
  room?: PeerRoom<Ch>
  channel?: string
  member?: PeerRoomMember
}

export interface PeerClientOptions<Ch extends PeerChannels = PeerChannels> {
  /** STUN/TURN servers, or a function called per peer connection (to vend short-lived TURN credentials). */
  iceServers?: RTCIceServer[] | (() => Awaitable<RTCIceServer[]>)
  iceTransportPolicy?: RTCIceTransportPolicy
  /** Data-channel encoding. Every member must use the same one. Default: core's `jsonSerializer`. */
  serializer?: Serializer
  /** The `RTCPeerConnection` constructor. Default `globalThis.RTCPeerConnection`. */
  rtc?: new (config?: RTCConfiguration) => RTCPeerConnection
  /** Dropped inbound messages and link errors. Default: a LogTape warning under `['super-line','plugin-peer','client']`. */
  onError?: (error: unknown, info: PeerErrorInfo<Ch>) => void
  /** How long `join` waits for admission (default 30000). Also the lifetime of held early frames. */
  joinTimeoutMs?: number
  /** A link not open within this is closed and marked `failed` (default 15000). */
  connectTimeoutMs?: number
  /** Send a control ping after this long without sending anything on a link (default 1000). */
  pingIdleMs?: number
  /** Declare a member gone after this long without hearing from it (default 3000). */
  livenessTimeoutMs?: number
  /** A `reliable: false` channel skips a link whose `bufferedAmount` is above this (default 16384). */
  lossyBufferedAmount?: number
  /** Re-join attempts before a joined room closes with `'lost'` (default 8). */
  rejoinAttempts?: number
  /** Delay before the first re-join retry, doubling up to `rejoinMaxMs` (default 500). */
  rejoinBaseMs?: number
  /** Longest delay between re-join retries (default 5000). */
  rejoinMaxMs?: number
  /** Where `visibilitychange` and `pagehide` are heard. Default `globalThis.document`; `null` turns both off. */
  document?: PeerDocument | null
}

export interface PeerClient<Ch extends PeerChannels = PeerChannels> {
  createRoom(opts: PeerCreateRoomOptions): Promise<PeerRoom<Ch>>
  /** Ask to join `key`. Resolves on admission; rejects `FORBIDDEN` on a reject and `TIMEOUT` when nobody answers. */
  join(key: string): Promise<PeerRoom<Ch>>
  /** Leave every room, close every link and detach from the client (NOT the underlying super-line client). */
  close(): void
}

interface Dyn {
  peerCreateRoom(i: { ownerSecret: string }): Promise<{ roomKey: string; self: PeerSelf }>
  peerCloseRoom(i: { ownerSecret: string }): Promise<unknown>
  peerJoin(i: { roomKey: string; ticket: string }): Promise<{ self: PeerSelf }>
  peerAdmit(i: {
    ownerSecret: string
    joiner: { connId: string; info?: PeerInfo }
    accept: boolean
    members: Array<{ connId: string; info?: PeerInfo }>
  }): Promise<unknown>
  peerRemove(i: { ownerSecret: string; member: string; members: string[] }): Promise<unknown>
  peerSignal(i: unknown): Promise<unknown>
  on(event: string, handler: (data: unknown) => void): () => void
  onReconnect(cb: () => void): () => void
  readonly connected: boolean
}

interface Link {
  readonly state: PeerLinkState
  signal(s: PeerSignal): void
  ready(index: number): boolean
  buffered(index: number): number
  maxMessageSize(): number
  send(index: number, data: string | Uint8Array): void
  bye(): void
  close(farewell?: Farewell): void
}

type Farewell = 'bye' | 'end'

interface Member {
  id: string
  role?: string
  info?: PeerInfo
  link: Link
}

interface Owner {
  secret: string
  keyHash: string
  accept: (joiner: PeerJoiner) => Awaitable<boolean>
  maxMembers: number
  tickets: Map<string, string>
  queue: PeerJoinRequest[]
  busy: boolean
  claim: Promise<unknown>
}

interface Rejoin {
  attempts: number
  timer: Timer | undefined
  self: PeerSelf | undefined
  admitted: PeerAdmitted | undefined
}

interface Room<Ch extends PeerChannels> {
  key: string
  self: PeerSelf
  owner?: Owner
  ticket?: string
  creator?: string
  rejoin?: Rejoin
  members: Map<string, Member>
  stateListeners: Set<(state: PeerRoomState) => void>
  memberListeners: Set<(event: PeerMemberEvent) => void>
  closeListeners: Set<(reason: PeerCloseReason) => void>
  channelListeners: Map<string, Set<(message: never, from: PeerRoomMember) => void>>
  closed: boolean
  api: PeerRoom<Ch>
}

interface Pending<Ch extends PeerChannels> {
  key: string
  self?: PeerSelf
  admitted?: PeerAdmitted
  timer: Timer
  resolve: (room: PeerRoom<Ch>) => void
  reject: (err: unknown) => void
  promise: Promise<PeerRoom<Ch>>
}

interface Held {
  from: string | null
  at: number
  bytes: number
  frame: PeerSignal | PeerJoined
}

const snapshot = (m: Member): PeerRoomMember => ({
  id: m.id,
  ...(m.role !== undefined ? { role: m.role } : {}),
  ...(m.info !== undefined ? { info: m.info } : {}),
  link: m.link.state,
})

const byteLength = (data: string | Uint8Array | ArrayBuffer): number =>
  typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength

const iceInit = (c: RTCIceCandidate): PeerIceCandidate => ({
  candidate: c.candidate,
  ...(c.sdpMid != null ? { sdpMid: c.sdpMid } : {}),
  ...(c.sdpMLineIndex != null ? { sdpMLineIndex: c.sdpMLineIndex } : {}),
  ...(c.usernameFragment != null ? { usernameFragment: c.usernameFragment } : {}),
})

/**
 * The client half of the peer plugin: keyed rooms whose members talk directly over WebRTC data
 * channels, after the server has admitted them and relayed their signaling.
 *
 * One instance wraps ONE connected client; after a plugin-auth session replacement, build a fresh
 * `peerClient` for the new client.
 */
export function peerClient<C extends Contract, R extends RoleOf<C>, Ch extends PeerChannels>(
  client: SuperLineClient<C, R>,
  contract: { readonly channels: Ch },
  opts: PeerClientOptions<Ch> = {},
): PeerClient<Ch> {
  const dyn = client as unknown as Dyn
  const Rtc = opts.rtc ?? globalThis.RTCPeerConnection
  if (!Rtc) throw new SuperLineError('BAD_REQUEST', 'RTCPeerConnection is not available here; pass `rtc`')
  const serializer = opts.serializer ?? jsonSerializer
  const joinTimeoutMs = opts.joinTimeoutMs ?? 30_000
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000
  const pingIdleMs = opts.pingIdleMs ?? 1_000
  const livenessTimeoutMs = opts.livenessTimeoutMs ?? 3_000
  const lossyBufferedAmount = opts.lossyBufferedAmount ?? 16_384
  const rejoinAttempts = opts.rejoinAttempts ?? 8
  const rejoinBaseMs = opts.rejoinBaseMs ?? 500
  const rejoinMaxMs = opts.rejoinMaxMs ?? 5_000
  const doc = opts.document === undefined ? (globalThis.document as PeerDocument | undefined) : opts.document
  const page = doc ? (doc.defaultView ?? doc) : undefined
  const onError =
    opts.onError ??
    ((error: unknown, info: PeerErrorInfo<Ch>) =>
      log.warn('peer error on channel {channel} member {member}: {error}', {
        error,
        channel: info.channel,
        member: info.member?.id,
      }))

  const defs = contract.channels
  const names = Object.keys(defs).sort()

  const rooms = new Map<string, Room<Ch>>()
  const owned = new Map<string, Room<Ch>>()
  const pending = new Map<string, Pending<Ch>>()
  const tickets = new Map<string, string>()
  const held = new Map<string, Held[]>()
  let closed = false
  let announce!: () => void
  let reconnected = new Promise<void>((resolve) => (announce = resolve))

  const report = (error: unknown, info: PeerErrorInfo<Ch>) => {
    try {
      onError(error, info)
    } catch {}
  }

  function hold(key: string, from: string | null, frame: PeerSignal | PeerJoined) {
    const now = Date.now()
    const list = (held.get(key) ?? []).filter((e) => now - e.at < joinTimeoutMs)
    held.set(key, list)
    if (list.length >= HELD_PER_KEY) return
    if (list.filter((e) => e.from === from).length >= HELD_PER_SENDER) return
    const bytes = byteLength(JSON.stringify(frame))
    if (list.reduce((sum, e) => sum + e.bytes, bytes) > HELD_BYTES_PER_KEY) return
    list.push({ from, at: now, bytes, frame })
  }

  function take(key: string, from: string | null): Held['frame'][] {
    const list = held.get(key)
    if (!list) return []
    const now = Date.now()
    const out: Held['frame'][] = []
    const keep: Held[] = []
    for (const e of list) {
      if (now - e.at >= joinTimeoutMs) continue
      if (e.from === from) out.push(e.frame)
      else keep.push(e)
    }
    if (keep.length) held.set(key, keep)
    else held.delete(key)
    return out
  }

  function emitMember(room: Room<Ch>, event: PeerMemberEvent) {
    for (const cb of room.memberListeners) {
      try {
        cb(event)
      } catch (err) {
        report(err, { room: room.api, member: event.member })
      }
    }
  }

  function addMember(room: Room<Ch>, entry: { id: string; role?: string; info?: PeerInfo }) {
    if (room.closed || entry.id === room.self.connId || room.members.has(entry.id)) return
    const member = { ...entry } as Member
    member.link = createLink(room, member)
    room.members.set(member.id, member)
    emitMember(room, { type: 'joined', member: snapshot(member) })
    for (const frame of take(room.key, member.id)) onSignal(frame as PeerSignal)
  }

  function removeMember(room: Room<Ch>, id: string) {
    const member = room.members.get(id)
    if (!member) return
    room.members.delete(id)
    member.link.close()
    emitMember(room, { type: 'left', member: snapshot(member) })
    if (id === room.creator) startRejoin(room)
  }

  const stateOf = (room: Room<Ch>): PeerRoomState => (room.closed ? 'closed' : room.rejoin ? 'rejoining' : 'active')

  function emitState(room: Room<Ch>) {
    const state = stateOf(room)
    for (const cb of room.stateListeners) {
      try {
        cb(state)
      } catch (err) {
        report(err, { room: room.api })
      }
    }
  }

  const giveUp = (ownerSecret: string) => void dyn.peerCloseRoom({ ownerSecret }).catch(() => {})

  const disconnected = (err: unknown) => err instanceof SuperLineError && err.code === 'DISCONNECTED'

  function closeRoom(room: Room<Ch>, reason: PeerCloseReason) {
    if (room.closed) return
    room.closed = true
    rooms.delete(room.key)
    if (room.owner) {
      owned.delete(room.owner.keyHash)
      giveUp(room.owner.secret)
    }
    clearTimeout(room.rejoin?.timer)
    room.rejoin = undefined
    held.delete(room.key)
    for (const member of room.members.values()) member.link.close(room.owner ? 'end' : 'bye')
    room.members.clear()
    emitState(room)
    for (const cb of room.closeListeners) {
      try {
        cb(reason)
      } catch (err) {
        report(err, { room: room.api })
      }
    }
  }

  function createLink(room: Room<Ch>, member: Member): Link {
    const peerId = member.id
    const selfId = room.self.connId
    const polite = selfId > peerId
    const dcs: RTCDataChannel[] = []
    const early: Array<[number, string | ArrayBuffer]> = []
    const candidates: PeerIceCandidate[] = []
    let pc: RTCPeerConnection | undefined
    let state: PeerLinkState = 'connecting'
    let released = false
    let helloOk = false
    let makingOffer = false
    let ignoreOffer = false
    let settingAnswer = false
    let described = false
    let lastHeard = 0
    let lastSent = 0
    let liveness: ReturnType<typeof setInterval> | undefined
    const connectTimer = setTimeout(() => {
      if (state === 'open') return
      if (room.owner) removeMember(room, peerId)
      else fail()
    }, connectTimeoutMs)

    const info = (channel?: string): PeerErrorInfo<Ch> => ({
      room: room.api,
      member: snapshot(member),
      ...(channel !== undefined ? { channel } : {}),
    })

    const sendSignal = (body: object) => {
      dyn.peerSignal({ roomKey: room.key, to: peerId, ...body }).catch((err) => {
        if (!released) report(err, info())
      })
    }

    const sendDescription = () => {
      const d = pc?.localDescription
      if (d && (d.type === 'offer' || d.type === 'answer')) sendSignal({ kind: d.type, sdp: d.sdp })
    }

    const sendControl = (msg: object) => {
      const dc = dcs[0]
      if (dc?.readyState !== 'open') return false
      try {
        dc.send(JSON.stringify(msg))
        lastSent = Date.now()
        return true
      } catch {
        return false
      }
    }

    function release(farewell?: Farewell) {
      released = true
      clearInterval(liveness)
      const said = farewell !== undefined && sendControl({ t: farewell })
      for (const dc of dcs) dc.onopen = dc.onmessage = dc.onclose = null
      if (pc) pc.onnegotiationneeded = pc.onicecandidate = pc.onconnectionstatechange = null
      let left = dcs.length
      const finish = () => {
        clearTimeout(grace)
        pc?.close()
      }
      const grace = setTimeout(finish, CLOSE_GRACE_MS)
      const closed = () => {
        if (--left === 0) finish()
      }
      const shut = (dc: RTCDataChannel, then = closed) => {
        if (dc.readyState === 'closed') return then()
        dc.onclose = () => {
          dc.onclose = null
          then()
        }
        try {
          dc.close()
        } catch {}
      }
      if (!dcs.length) finish()
      else if (said) {
        shut(dcs[0]!, () => {
          for (const dc of dcs.slice(1)) shut(dc)
          closed()
        })
      } else for (const dc of dcs) shut(dc)
    }

    function fail(error?: unknown) {
      if (released) return
      release()
      state = 'failed'
      emitMember(room, { type: 'link', member: snapshot(member) })
      if (error !== undefined) report(error, info())
    }

    function lost() {
      if (released) return
      if (state === 'open') removeMember(room, peerId)
      else fail()
    }

    function maybeOpen() {
      if (state !== 'connecting' || !helloOk || dcs.some((dc) => dc.readyState !== 'open')) return
      state = 'open'
      clearTimeout(connectTimer)
      lastHeard = lastSent = Date.now()
      liveness = setInterval(
        () => {
          const now = Date.now()
          if (now - lastHeard >= livenessTimeoutMs) removeMember(room, peerId)
          else if (now - lastSent >= pingIdleMs) sendControl({ t: 'ping' })
        },
        Math.max(1, Math.floor(pingIdleMs / 2)),
      )
      emitMember(room, { type: 'link', member: snapshot(member) })
    }

    function deliver(index: number, data: string | ArrayBuffer) {
      const name = names[index - 1]!
      const def = defs[name]!
      try {
        const size = byteLength(data)
        if (size > (def.maxBytes ?? FALLBACK_MAX_MESSAGE)) {
          throw new SuperLineError('BAD_REQUEST', `Peer message of ${size} bytes exceeds the channel limit`)
        }
        const value = validateSync(def.schema, serializer.decode(typeof data === 'string' ? data : new Uint8Array(data)))
        const from = snapshot(member)
        for (const handler of room.channelListeners.get(name) ?? []) {
          try {
            handler(value as never, from)
          } catch (err) {
            report(err, info(name))
          }
        }
      } catch (err) {
        report(err, info(name))
      }
    }

    function control(data: string | ArrayBuffer) {
      let msg: unknown
      try {
        msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
      } catch {}
      if (!helloOk) {
        const hello = helloSchema.safeParse(msg)
        if (!hello.success || hello.data.from !== peerId || hello.data.to !== selfId || hello.data.roomKey !== room.key) {
          return fail(new SuperLineError('FORBIDDEN', 'Peer hello does not match the link'))
        }
        helloOk = true
        maybeOpen()
        for (const [index, d] of early.splice(0)) deliver(index, d)
        return
      }
      const t = (msg as { t?: unknown } | undefined)?.t
      if (t === 'bye') removeMember(room, peerId)
      else if (t === 'end' && peerId === room.creator) closeRoom(room, 'ended')
    }

    function setup(dc: RTCDataChannel, index: number) {
      dc.binaryType = 'arraybuffer'
      dc.onopen = () => {
        if (index === 0) sendControl({ t: 'hello', from: selfId, to: peerId, roomKey: room.key })
        maybeOpen()
      }
      dc.onmessage = (ev: MessageEvent<string | ArrayBuffer>) => {
        lastHeard = Date.now()
        if (index === 0) control(ev.data)
        else if (helloOk) deliver(index, ev.data)
        else if (early.length < EARLY_MESSAGES) early.push([index, ev.data])
      }
      dc.onclose = lost
      dcs.push(dc)
    }

    async function addCandidate(candidate: PeerIceCandidate) {
      try {
        await pc!.addIceCandidate(candidate)
      } catch (err) {
        if (!ignoreOffer) report(err, info())
      }
    }

    async function build() {
      const iceServers = typeof opts.iceServers === 'function' ? await opts.iceServers() : opts.iceServers
      if (released) return
      const peer = new Rtc({
        ...(iceServers ? { iceServers } : {}),
        ...(opts.iceTransportPolicy ? { iceTransportPolicy: opts.iceTransportPolicy } : {}),
      })
      pc = peer
      peer.onnegotiationneeded = async () => {
        if (peer.signalingState !== 'stable' || (polite && !described)) return
        try {
          makingOffer = true
          await peer.setLocalDescription()
          sendDescription()
        } catch (err) {
          if (!released) report(err, info())
        } finally {
          makingOffer = false
        }
      }
      peer.onicecandidate = ({ candidate }) => {
        sendSignal({ kind: 'candidate', candidate: candidate ? iceInit(candidate) : { candidate: '' } })
      }
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') lost()
      }
      setup(peer.createDataChannel('control', { negotiated: true, id: 0 }), 0)
      names.forEach((name, i) => {
        const lossy = defs[name]!.reliable === false
        const init: RTCDataChannelInit = { negotiated: true, id: i + 1, ...(lossy ? { ordered: false, maxRetransmits: 0 } : {}) }
        setup(peer.createDataChannel(name, init), i + 1)
      })
      if (peer.signalingState === 'have-local-offer') sendDescription()
    }

    async function handle(s: PeerSignal) {
      if (released || !pc) return
      if (s.kind === 'candidate') {
        if (described) await addCandidate(s.candidate)
        else if (candidates.length < PENDING_CANDIDATES) candidates.push(s.candidate)
        return
      }
      const readyForOffer = !makingOffer && (pc.signalingState === 'stable' || settingAnswer)
      ignoreOffer = !polite && s.kind === 'offer' && !readyForOffer
      if (ignoreOffer) return
      settingAnswer = s.kind === 'answer'
      await pc.setRemoteDescription({ type: s.kind, sdp: s.sdp })
      settingAnswer = false
      described = true
      if (s.kind === 'offer') {
        await pc.setLocalDescription()
        sendDescription()
      }
      for (const c of candidates.splice(0)) await addCandidate(c)
    }

    let chain = build().catch((err) => fail(err))

    return {
      get state() {
        return state
      },
      signal(s) {
        chain = chain
          .then(() => handle(s))
          .catch((err) => {
            if (!released) report(err, info())
          })
      },
      ready: (index) => state === 'open' && dcs[index]?.readyState === 'open',
      buffered: (index) => dcs[index]?.bufferedAmount ?? 0,
      maxMessageSize() {
        const max = pc?.sctp?.maxMessageSize
        return max && Number.isFinite(max) && max > 0 ? max : FALLBACK_MAX_MESSAGE
      },
      send(index, data) {
        dcs[index]!.send(data as string)
        lastSent = Date.now()
      },
      bye: () => void sendControl({ t: 'bye' }),
      close(farewell) {
        clearTimeout(connectTimer)
        if (!released) release(farewell)
      },
    }
  }

  function makeRoom(key: string, self: PeerSelf, owner?: Owner): Room<Ch> {
    const room = {
      key,
      self,
      members: new Map(),
      stateListeners: new Set(),
      memberListeners: new Set(),
      closeListeners: new Set(),
      channelListeners: new Map(),
      closed: false,
      ...(owner ? { owner } : {}),
    } as Room<Ch>

    const tooLarge = (size: number, link: Link) => {
      const max = link.maxMessageSize()
      if (size > max) throw new SuperLineError('BAD_REQUEST', `Peer message of ${size} bytes exceeds the link limit of ${max}`)
    }

    const channel = (name: string) => {
      const index = names.indexOf(name) + 1
      if (index === 0) throw new SuperLineError('NOT_FOUND', `Unknown peer channel '${name}'`)
      const lossy = defs[name]!.reliable === false
      const skip = (link: Link) => lossy && link.buffered(index) > lossyBufferedAmount
      return {
        send(message: unknown) {
          const data = serializer.encode(message)
          const size = byteLength(data)
          const links = [...room.members.values()].map((m) => m.link).filter((l) => l.ready(index))
          for (const link of links) tooLarge(size, link)
          for (const link of links) {
            if (skip(link)) continue
            try {
              link.send(index, data)
            } catch {}
          }
        },
        to(memberId: string) {
          return {
            send(message: unknown) {
              const member = room.members.get(memberId)
              if (!member) throw new SuperLineError('NOT_FOUND', `No member '${memberId}' in this room`)
              if (!member.link.ready(index)) throw new SuperLineError('DISCONNECTED', `The link to '${memberId}' is not open`)
              const data = serializer.encode(message)
              tooLarge(byteLength(data), member.link)
              if (!skip(member.link)) member.link.send(index, data)
            },
          }
        },
        on(handler: (message: never, from: PeerRoomMember) => void) {
          let set = room.channelListeners.get(name)
          if (!set) room.channelListeners.set(name, (set = new Set()))
          set.add(handler)
          return () => void set.delete(handler)
        },
      }
    }

    room.api = {
      key,
      get self() {
        return { id: room.self.connId, role: room.self.role }
      },
      get members() {
        return [...room.members.values()].map(snapshot)
      },
      get state() {
        return stateOf(room)
      },
      onState(cb) {
        room.stateListeners.add(cb)
        return () => void room.stateListeners.delete(cb)
      },
      onMember(cb) {
        room.memberListeners.add(cb)
        return () => void room.memberListeners.delete(cb)
      },
      channel: channel as PeerRoom<Ch>['channel'],
      async kick(memberId) {
        const o = room.owner
        if (!o) throw new SuperLineError('FORBIDDEN', 'Only the room creator can kick')
        for (const [ticket, id] of o.tickets) if (id === memberId) o.tickets.delete(ticket)
        removeMember(room, memberId)
        await dyn.peerRemove({ ownerSecret: o.secret, member: memberId, members: [...room.members.keys()] })
      },
      leave: () => closeRoom(room, 'left'),
      onClose(cb) {
        room.closeListeners.add(cb)
        return () => void room.closeListeners.delete(cb)
      },
    }
    return room
  }

  async function admit(room: Room<Ch>, o: Owner, request: PeerJoinRequest) {
    const id = request.joiner.connId
    if (id === room.self.connId || room.members.has(id)) return
    const info = request.joiner.info
    const joiner: PeerJoiner = { id, role: request.joiner.role, ...(info !== undefined ? { info } : {}) }
    const previous = o.tickets.get(request.ticket)
    let accept = false
    if (previous !== undefined) {
      if (previous !== id) {
        removeMember(room, previous)
        dyn
          .peerRemove({ ownerSecret: o.secret, member: previous, members: [...room.members.keys()] })
          .catch((err) => report(err, { room: room.api }))
      }
      accept = true
    } else {
      try {
        accept = (await o.accept(joiner)) === true
      } catch (err) {
        report(err, { room: room.api })
      }
    }
    await o.claim
    while (!dyn.connected && !room.closed) {
      await reconnected
      await o.claim
    }
    if (room.closed || room.members.has(id)) return
    if (room.members.size + 2 > o.maxMembers) accept = false
    const members = accept
      ? [...room.members.values()].map((m) => ({ connId: m.id, ...(m.info !== undefined ? { info: m.info } : {}) }))
      : []
    const admitted = dyn.peerAdmit({
      ownerSecret: o.secret,
      joiner: { connId: id, ...(info !== undefined ? { info } : {}) },
      accept,
      members,
    })
    if (accept) {
      o.tickets.set(request.ticket, id)
      addMember(room, joiner)
    }
    try {
      await admitted
    } catch (err) {
      if (accept) removeMember(room, id)
      report(err, { room: room.api })
    }
  }

  async function pump(room: Room<Ch>, o: Owner) {
    if (o.busy) return
    o.busy = true
    try {
      while (!room.closed && o.queue.length) await admit(room, o, o.queue.shift()!)
    } finally {
      o.busy = false
    }
  }

  function onJoinRequest(request: PeerJoinRequest) {
    const room = owned.get(request.keyHash)
    const o = room?.owner
    if (!room || !o) return
    const id = request.joiner.connId
    if (id === room.self.connId || room.members.has(id) || o.queue.length >= ADMISSION_QUEUE) return
    o.queue.push(request)
    void pump(room, o)
  }

  function onSignal(s: PeerSignal) {
    const room = rooms.get(s.roomKey)
    const member = room && !room.rejoin ? room.members.get(s.from.connId) : undefined
    if (member) {
      member.role ??= s.from.role
      member.link.signal(s)
    } else if (room || pending.has(s.roomKey)) hold(s.roomKey, s.from.connId, s)
  }

  function onJoined(j: PeerJoined) {
    const room = rooms.get(j.roomKey)
    const entry = { id: j.member.connId, ...(j.member.info !== undefined ? { info: j.member.info } : {}) }
    if (room && !room.rejoin) addMember(room, entry)
    else if (room || pending.has(j.roomKey)) hold(j.roomKey, null, j)
  }

  function onLeft(l: PeerLeft) {
    const room = rooms.get(l.roomKey)
    if (!room) return
    if (l.member === room.self.connId || l.member === room.rejoin?.self?.connId) closeRoom(room, 'kicked')
    else removeMember(room, l.member)
  }

  function populate(room: Room<Ch>, a: PeerAdmitted) {
    room.creator = a.by.connId
    addMember(room, { id: a.by.connId, role: a.by.role })
    for (const m of a.members) addMember(room, { id: m.connId, ...(m.info !== undefined ? { info: m.info } : {}) })
    for (const id of room.members.keys()) for (const frame of take(room.key, id)) onSignal(frame as PeerSignal)
    for (const frame of take(room.key, null)) onJoined(frame as PeerJoined)
  }

  function startRejoin(room: Room<Ch>) {
    if (room.closed || room.owner || room.rejoin) return
    room.rejoin = { attempts: 0, timer: undefined, self: undefined, admitted: undefined }
    emitState(room)
    attemptRejoin(room)
  }

  function attemptRejoin(room: Room<Ch>) {
    const r = room.rejoin
    if (!r) return
    clearTimeout(r.timer)
    if (closed || !dyn.connected) return
    if (r.attempts >= rejoinAttempts) return closeRoom(room, 'lost')
    r.timer = setTimeout(() => attemptRejoin(room), Math.min(rejoinBaseMs * 2 ** r.attempts, rejoinMaxMs))
    r.attempts++
    dyn.peerJoin({ roomKey: room.key, ticket: room.ticket! }).then(
      ({ self }) => {
        if (room.rejoin !== r) return
        r.self = self
        finishRejoin(room)
      },
      (err) => {
        if (room.rejoin !== r) return
        if (err instanceof SuperLineError && err.code === 'FORBIDDEN') closeRoom(room, 'refused')
        else if (!disconnected(err)) report(err, { room: room.api })
      },
    )
  }

  function finishRejoin(room: Room<Ch>) {
    const r = room.rejoin
    if (!r?.self || !r.admitted) return
    const { self, admitted } = r
    const changed = self.connId !== room.self.connId
    const fresh = new Set([admitted.by.connId, ...admitted.members.map((m) => m.connId)])
    for (const [id, m] of room.members) {
      if (changed || id === admitted.by.connId || !fresh.has(id) || m.link.state !== 'open') removeMember(room, id)
    }
    clearTimeout(r.timer)
    room.rejoin = undefined
    room.self = self
    populate(room, admitted)
    emitState(room)
  }

  function settle(p: Pending<Ch>, error?: unknown) {
    if (pending.get(p.key) !== p) return false
    pending.delete(p.key)
    clearTimeout(p.timer)
    if (error !== undefined) {
      held.delete(p.key)
      p.reject(error)
    }
    return true
  }

  function maybeAdmitted(p: Pending<Ch>) {
    const { self, admitted } = p
    if (!self || !admitted || !settle(p)) return
    const room = makeRoom(p.key, self)
    room.ticket = tickets.get(p.key)!
    rooms.set(p.key, room)
    populate(room, admitted)
    p.resolve(room.api)
  }

  function onAdmitted(a: PeerAdmitted) {
    const p = pending.get(a.roomKey)
    const room = p ? undefined : rooms.get(a.roomKey)
    const r = room?.rejoin
    if (room && r) {
      if (!a.accept) return closeRoom(room, 'refused')
      r.admitted = a
      return finishRejoin(room)
    }
    if (!p) return
    if (!a.accept) return void settle(p, new SuperLineError('FORBIDDEN', 'The room creator rejected the join'))
    p.admitted = a
    maybeAdmitted(p)
  }

  function reclaim(room: Room<Ch>, o: Owner) {
    return dyn.peerCreateRoom({ ownerSecret: o.secret }).then(
      ({ self }) => {
        if (room.closed) giveUp(o.secret)
        else room.self = self
      },
      (err) => {
        if (room.closed) return
        if (err instanceof SuperLineError && err.code === 'FORBIDDEN') closeRoom(room, 'refused')
        else if (!disconnected(err)) report(err, { room: room.api })
      },
    )
  }

  const listen = <S extends z.ZodType>(event: string, schema: S, handler: (data: z.infer<S>) => void) =>
    dyn.on(event, (data) => {
      const parsed = schema.safeParse(data)
      if (parsed.success) handler(parsed.data)
    })

  const offs = [
    listen('peer.joinRequest', stc['peer.joinRequest'].payload, onJoinRequest),
    listen('peer.admitted', stc['peer.admitted'].payload, onAdmitted),
    listen('peer.joined', stc['peer.joined'].payload, onJoined),
    listen('peer.left', stc['peer.left'].payload, onLeft),
    listen('peer.signal', stc['peer.signal'].payload, onSignal),
  ]

  const offReconnect = dyn.onReconnect(() => {
    for (const room of rooms.values()) {
      const o = room.owner
      if (o) o.claim = reclaim(room, o)
      else if (room.rejoin) {
        room.rejoin.self = room.rejoin.admitted = undefined
        attemptRejoin(room)
      } else startRejoin(room)
    }
    announce()
    reconnected = new Promise((resolve) => (announce = resolve))
  })

  const onVisibility = () => {
    if (doc?.visibilityState !== 'visible') return
    for (const room of rooms.values()) {
      if (room.owner) continue
      if (room.rejoin) attemptRejoin(room)
      else if (room.members.get(room.creator!)?.link.state !== 'open') startRejoin(room)
    }
  }

  const onPageHide = () => {
    for (const room of rooms.values()) for (const member of room.members.values()) member.link.bye()
  }
  doc?.addEventListener('visibilitychange', onVisibility)
  page?.addEventListener('pagehide', onPageHide)

  const closedError = () => new SuperLineError('DISCONNECTED', 'Peer client closed')

  return {
    async createRoom({ accept, maxMembers = MAX_ROOM_MEMBERS }) {
      if (closed) throw closedError()
      if (!Number.isInteger(maxMembers) || maxMembers < 2 || maxMembers > MAX_ROOM_MEMBERS) {
        throw new SuperLineError('BAD_REQUEST', `maxMembers must be an integer from 2 to ${MAX_ROOM_MEMBERS}`)
      }
      if (!globalThis.crypto?.subtle) {
        throw new SuperLineError('BAD_REQUEST', 'createRoom needs crypto.subtle: serve the page over HTTPS or from localhost')
      }
      const secret = peerSecret()
      const keyHash = await peerHash(await peerHash(secret))
      const { roomKey, self } = await dyn.peerCreateRoom({ ownerSecret: secret })
      if (closed) {
        giveUp(secret)
        throw closedError()
      }
      const room = makeRoom(roomKey, self, {
        secret,
        keyHash,
        accept,
        maxMembers,
        tickets: new Map(),
        queue: [],
        busy: false,
        claim: Promise.resolve(),
      })
      rooms.set(roomKey, room)
      owned.set(keyHash, room)
      return room.api
    },

    join(key) {
      if (closed) return Promise.reject(closedError())
      const room = rooms.get(key)
      if (room?.owner) return Promise.reject(new SuperLineError('BAD_REQUEST', 'Cannot join a room you created'))
      if (room) return Promise.resolve(room.api)
      const existing = pending.get(key)
      if (existing) return existing.promise
      let ticket = tickets.get(key)
      if (!ticket) tickets.set(key, (ticket = peerSecret()))
      const p = { key } as Pending<Ch>
      p.promise = new Promise((resolve, reject) => {
        p.resolve = resolve
        p.reject = reject
      })
      p.timer = setTimeout(() => settle(p, new SuperLineError('TIMEOUT', 'Nobody admitted the join in time')), joinTimeoutMs)
      pending.set(key, p)
      dyn.peerJoin({ roomKey: key, ticket }).then(
        ({ self }) => {
          p.self = self
          maybeAdmitted(p)
        },
        (err) => settle(p, err),
      )
      return p.promise
    },

    close() {
      if (closed) return
      closed = true
      for (const off of offs) off()
      offReconnect()
      doc?.removeEventListener('visibilitychange', onVisibility)
      page?.removeEventListener('pagehide', onPageHide)
      for (const p of pending.values()) settle(p, closedError())
      for (const room of rooms.values()) closeRoom(room, 'closed')
      announce()
    },
  }
}
