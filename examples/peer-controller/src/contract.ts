import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { peerContract } from '@super-line/plugin-peer'

const axis = z.number().min(-1).max(1)

export const controls = peerContract({
  channels: {
    stick: { schema: z.object({ x: axis, y: axis }), reliable: false, maxBytes: 256 },
    events: {
      schema: z.discriminatedUnion('type', [
        z.object({ type: z.literal('press'), button: z.literal('a') }),
        z.object({ type: z.literal('ping'), t: z.number() }),
        z.object({ type: z.literal('pong'), t: z.number() }),
        z.object({ type: z.literal('color'), color: z.string().max(32) }),
        z.object({ type: z.literal('bump') }),
      ]),
      maxBytes: 1024,
    },
  },
})

export const contract = defineContract({
  roles: { screen: {}, controller: {} },
  plugins: [controls],
})

export type Role = 'screen' | 'controller'

export interface Config {
  joinBase: string
  iceServers: RTCIceServer[]
}

export const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
