import * as z from 'zod'
import { defineContractPlugin, defineSurface } from '@super-line/core'
import type { InferIn, InferOut, Schema } from '@super-line/core'

const base64url = (length: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`))

const SECRET_LENGTH = 22
const HASH_LENGTH = 43
const MAX_MEMBERS = 32
const MAX_SDP = 65_536
const MAX_CANDIDATE = 2_048

const secret = base64url(SECRET_LENGTH)
const hash = base64url(HASH_LENGTH)
const connId = z.string().min(1).max(128)
const role = z.string().max(128)

const infoSchema = z
  .record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()]))
  .refine((info) => Object.keys(info).length <= 16, 'at most 16 info fields')
const selfSchema = z.strictObject({ connId, role })
const memberSchema = z.strictObject({ connId, info: infoSchema.optional() })
const members = z.array(memberSchema).max(MAX_MEMBERS)

const candidateSchema = z.strictObject({
  candidate: z.string().max(MAX_CANDIDATE),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(65_535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
})
const signalBody = {
  offer: { kind: z.literal('offer'), sdp: z.string().max(MAX_SDP) },
  answer: { kind: z.literal('answer'), sdp: z.string().max(MAX_SDP) },
  candidate: { kind: z.literal('candidate'), candidate: candidateSchema },
}
const signal = <E extends z.core.$ZodShape>(extra: E) =>
  z.discriminatedUnion('kind', [
    z.strictObject({ ...extra, ...signalBody.offer }),
    z.strictObject({ ...extra, ...signalBody.answer }),
    z.strictObject({ ...extra, ...signalBody.candidate }),
  ])

const empty = z.strictObject({})

export const peerSurface = defineSurface({
  clientToServer: {
    peerCreateRoom: {
      input: z.strictObject({ ownerSecret: secret }),
      output: z.strictObject({ roomKey: hash, self: selfSchema }),
    },
    peerJoin: {
      input: z.strictObject({ roomKey: hash, ticket: secret }),
      output: z.strictObject({ self: selfSchema }),
    },
    peerAdmit: {
      input: z.strictObject({ ownerSecret: secret, joiner: memberSchema, accept: z.boolean(), members }),
      output: empty,
    },
    peerRemove: {
      input: z.strictObject({ ownerSecret: secret, member: connId, members: z.array(connId).max(MAX_MEMBERS) }),
      output: empty,
    },
    peerSignal: {
      input: signal({ roomKey: hash, to: connId }),
      output: empty,
    },
  },
  serverToClient: {
    'peer.joinRequest': {
      payload: z.strictObject({
        keyHash: hash,
        ticket: secret,
        joiner: z.strictObject({ connId, role, info: infoSchema.optional() }),
      }),
    },
    'peer.admitted': {
      payload: z.strictObject({ roomKey: hash, accept: z.boolean(), by: selfSchema, members }),
    },
    'peer.joined': {
      payload: z.strictObject({ roomKey: hash, member: memberSchema }),
    },
    'peer.left': {
      payload: z.strictObject({ roomKey: hash, member: connId }),
    },
    'peer.signal': {
      payload: signal({ roomKey: hash, from: selfSchema }),
    },
  },
})
export type PeerSurface = typeof peerSurface

/** Host-chosen, server-attested public descriptor of a member (what `authorize` returns as `info`). */
export type PeerInfo = z.infer<typeof infoSchema>
/** A connection's server-verified identity. */
export type PeerSelf = z.infer<typeof selfSchema>
/** A room member as the wire carries it. */
export type PeerMember = z.infer<typeof memberSchema>
export type PeerIceCandidate = z.infer<typeof candidateSchema>
export type PeerSignalKind = 'offer' | 'answer' | 'candidate'

export type PeerJoinRequest = z.infer<PeerSurface['serverToClient']['peer.joinRequest']['payload']>
export type PeerAdmitted = z.infer<PeerSurface['serverToClient']['peer.admitted']['payload']>
export type PeerJoined = z.infer<PeerSurface['serverToClient']['peer.joined']['payload']>
export type PeerLeft = z.infer<PeerSurface['serverToClient']['peer.left']['payload']>
export type PeerSignal = z.infer<PeerSurface['serverToClient']['peer.signal']['payload']>

/**
 * One data channel. Channels are symmetric: both ends send and receive the same Standard Schema.
 * `reliable: false` makes it unordered with no retransmits. `maxBytes` caps an inbound message
 * before it is decoded (default 65536).
 */
export interface PeerChannelDef<S extends Schema = Schema> {
  schema: S
  reliable?: boolean
  maxBytes?: number
}
export type PeerChannels = Record<string, PeerChannelDef>

export type PeerChannelName<Ch extends PeerChannels> = keyof Ch & string
export type PeerMessageIn<Ch extends PeerChannels, N extends PeerChannelName<Ch>> = InferIn<Ch[N]['schema']>
export type PeerMessageOut<Ch extends PeerChannels, N extends PeerChannelName<Ch>> = InferOut<Ch[N]['schema']>
export type PeerChannelsOf<P extends { readonly channels: PeerChannels }> = P['channels']

/**
 * The contract-time half of the peer plugin. Pass it in `defineContract({ plugins: [...] })` and hand
 * the same object to `peerClient`, which reads the channel schemas from it.
 */
export function peerContract<const Ch extends PeerChannels>(opts: { channels: Ch }) {
  return Object.assign(defineContractPlugin('peer', { shared: peerSurface }), { channels: opts.channels })
}
export type PeerContract<Ch extends PeerChannels = PeerChannels> = ReturnType<typeof peerContract<Ch>>

const toBase64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** base64url(SHA-256(value)): `roomKey` from `ownerSecret`, `keyHash` from `roomKey`. */
export async function peerHash(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return toBase64url(new Uint8Array(digest))
}
