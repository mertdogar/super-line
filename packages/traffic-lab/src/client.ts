import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { lab } from './contract.js'
import { serveControl } from './control.js'
import { num, str } from './env.js'

const NAME = str('CLIENT_NAME')
const NODE_URL = str('NODE_URL')
const CTRL_PORT = num('CTRL_PORT', 8900)

let connId = ''
let connected = false

const client = createSuperLineClient(lab, {
  transport: webSocketClientTransport({ url: NODE_URL }),
  role: 'user',
  params: { name: NAME },
  crdtCollections: crdtCollectionsClient({ origin: NAME }),
  onConnect: () => {
    console.log(`[${NAME}] transport open`)
    void establish()
  },
  onDisconnect: (code) => {
    connected = false
    console.log(`[${NAME}] transport closed (${code})`)
  },
  onError: (err, info) => console.error(`[${NAME}] client error (${info.kind}):`, err),
})

client.on('direct', () => {})
client.on('roomMsg', () => {})

/**
 * Identity is re-resolved on every open, not once at boot: the connection id changes across a
 * reconnect, and a stale one would silently make phase 2's targeted emit address nobody.
 */
async function establish(): Promise<void> {
  try {
    const who = await client.whoami({})
    connId = who.connId
    connected = true
    console.log(`[${NAME}] ready on ${who.node} as ${connId}`)
  } catch (err) {
    console.error(`[${NAME}] whoami failed:`, err)
  }
}

let opCounter = 0
/** Op ids are namespaced per client so two clients can never mint the same id in one run. */
const nextOp = (): number => {
  opCounter += 1
  return Number(`${[...NAME].reduce((a, c) => a + c.charCodeAt(0), 0)}${String(opCounter).padStart(5, '0')}`)
}

async function runPhase(n: number): Promise<{ ops: number }> {
  let ops = 0
  if (n === 1) {
    await client.ping({ op: nextOp(), phase: n, from: NAME })
    ops++
  }
  return { ops }
}

serveControl(CTRL_PORT, {
  '/ready': () => ({ ok: connected, client: NAME, connId, node: NODE_URL }),
  '/phase': async (body) => runPhase(Number(body.phase)),
})

console.log(`[${NAME}] traffic-lab client · control :${CTRL_PORT} · dialing ${NODE_URL}`)
