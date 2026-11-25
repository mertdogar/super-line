# @super-line/plugin-peer

Direct client-to-client rooms for super-line. The server authorizes who may create a room and who may
ask to join, and relays the WebRTC handshake; after that, typed messages travel between clients over
WebRTC data channels and the server carries none of them. Built for latency the server hop can't meet,
such as phones acting as game controllers for a game on a desktop screen.

```bash
pnpm add @super-line/plugin-peer
```

```ts
// contract.ts
import * as z from 'zod'
import { defineContract } from '@super-line/core'
import { peerContract } from '@super-line/plugin-peer'

export const controls = peerContract({
  channels: {
    stick: { schema: z.object({ x: z.number(), y: z.number() }), reliable: false },
    events: { schema: z.object({ type: z.literal('press') }) },
  },
})
export const contract = defineContract({ roles: { screen: {}, controller: {} }, plugins: [controls] })

// server.ts
import { peer } from '@super-line/plugin-peer/server'

createSuperLineServer(contract, {
  // ...
  plugins: [
    peer({
      authorizeCreate: ({ creator }) => creator.role === 'screen',
      authorize: () => true,
    }).plugin,
  ],
})

// screen (creates the room)
import { peerClient } from '@super-line/plugin-peer/client'

const peers = peerClient(client, controls, { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
const room = await peers.createRoom({ accept: (joiner) => joiner.role === 'controller' })
showQrCode(`https://game.example.com/c#${room.key}`)
room.channel('stick').on((stick, from) => move(from.id, stick))

// controller (joins with the key, through its own peerClient)
const seat = await peers.join(key)
seat.channel('events').send({ type: 'press' })
```

Rooms are full meshes with per-member link state, kick and leave, and automatic re-join after a
reconnect. There is no relay through the server: supply STUN and TURN through `iceServers`. In a browser,
`createRoom` needs a secure context (HTTPS or `localhost`); `join` doesn't. In Node, pass an
`RTCPeerConnection` implementation as `rtc`.

**Trust model.** The server authorizes admission and stamps identity on everything it relays, but it
never sees, validates, or revokes peer messages: each receiving client validates them against the
channel schema. Membership and kicks are enforced by honest clients, and members learn each other's
connection ids and IP addresses.

## Guides

- [Link clients directly](https://super-line.dogar.biz/how-to/plugin-peer): setup, rooms, channels,
  reconnects, ICE, secure contexts, the full trust model, and operations
- [`peer-controller` example](https://github.com/mertdogar/super-line/tree/main/examples/peer-controller)
