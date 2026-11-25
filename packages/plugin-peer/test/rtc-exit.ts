// The child half of the clean-exit test: a creator and two joiners link over node-datachannel, one
// joiner leaves, the creator leaves, then everything is closed and the process must exit on its
// own. Run via tsx, not collected by vitest.
import * as z from 'zod'
import { RTCPeerConnection } from 'node-datachannel/polyfill'
import { defineContract } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { createLoopbackTransport } from '@super-line/transport-loopback'
import { peerContract } from '../src/index.js'
import { peer } from '../src/server.js'
import { peerClient, type PeerCloseReason, type PeerRoom } from '../src/client.js'

const peerDef = peerContract({ channels: { events: { schema: z.object({ type: z.string() }) } } })
const contract = defineContract({ roles: { user: {} }, plugins: [peerDef] })

async function until(pred: () => boolean, label: string) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > 15_000) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const loopback = createLoopbackTransport()
const srv = createSuperLineServer(contract, {
  transports: [loopback.server],
  authenticate: () => ({ role: 'user' as const, ctx: {} }),
  plugins: [peer({ authorizeCreate: () => true, authorize: () => true }).plugin],
})
const member = () => {
  const client = createSuperLineClient(contract, { transport: loopback.client(), role: 'user' })
  const p = peerClient(client, peerDef, { rtc: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection })
  return { client, p }
}
const open = (room: PeerRoom, n: number) => room.members.length === n && room.members.every((m) => m.link === 'open')

const [tv, a, b] = [member(), member(), member()]
const host = await tv.p.createRoom({ accept: () => true })
const ra = await a.p.join(host.key)
const rb = await b.p.join(host.key)
await until(() => open(host, 2) && open(ra, 2) && open(rb, 2), 'the mesh')

const got: unknown[] = []
rb.channel('events').on((msg) => got.push(msg))
ra.channel('events').send({ type: 'hi' })
await until(() => got.length === 1, 'a message')

ra.leave()
await until(() => host.members.length === 1 && rb.members.length === 1, 'the leaver to be gone')

let reason: PeerCloseReason | undefined
rb.onClose((r) => (reason = r))
host.leave()
await until(() => reason !== undefined, 'the room to end')
console.log(`CLOSED ${reason}`)

for (const m of [tv, a, b]) {
  m.p.close()
  m.client.close()
}
await srv.close()
console.log('DONE')
