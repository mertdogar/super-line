import { eq } from '@super-line/core'
import { createSuperLineClient, type DocHandle } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { lab } from './contract.js'
import { serveControl } from './control.js'
import { num, runId, str } from './env.js'
import { Recorder } from './tap/record.js'
import { clientTapPlugin } from './tap/plugins.js'
import { sampleNic } from './tap/nic.js'
import { DOC_ID, DROP, EMIT_TARGET, KEEP, ROOM_CHURN, ROOM_LOCAL, ROOM_SPREAD, phaseByNumber } from './phases.js'

const NAME = str('CLIENT_NAME')
const NODE_URL = str('NODE_URL')
const CTRL_PORT = num('CTRL_PORT', 8900)
const OPS = num('OPS_PER_PHASE', 100)
const PACE_MS = num('PACE_MS', 10)

const rec = new Recorder(NAME, str('DUMP_DIR', '/runs'), runId())
rec.write({ layer: 'meta', adapter: 'client', inspector: false })

let connId = ''
let connected = false

const client = createSuperLineClient(lab, {
  transport: webSocketClientTransport({ url: NODE_URL }),
  role: 'user',
  params: { name: NAME },
  crdtCollections: crdtCollectionsClient({ origin: NAME }),
  plugins: [clientTapPlugin(rec)],
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
 * reconnect, and a stale one would silently make the targeted-emit phases address nobody.
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
const seed = [...NAME].reduce((a, c) => a + c.charCodeAt(0), 0)
const nextOp = (): number => {
  opCounter += 1
  return seed * 1_000_000 + opCounter
}

const pace = (): Promise<void> => new Promise((r) => setTimeout(r, PACE_MS))
const payload = (phase: number): { op: number; phase: number; from: string } => ({ op: nextOp(), phase, from: NAME })

type Doc = { title: string; cells: Record<string, number> }
let doc: DocHandle<Doc> | undefined

/**
 * Everything that would otherwise pollute a measured phase happens here: room joins, topic subscribes,
 * the collection subscription and the document open. A phase then does nothing but the one operation
 * it exists to measure.
 */
async function setup(): Promise<{ rooms: string[] }> {
  const rooms: string[] = []
  if (NAME === 'client-1a' || NAME === 'client-1b') rooms.push(ROOM_LOCAL)
  if (NAME === 'client-1a' || NAME === 'client-2' || NAME === 'client-3') rooms.push(ROOM_SPREAD)
  for (const room of rooms) await client.joinRoom({ room })
  await client.subscribe('announce', () => {}).ready
  // Filtered on purpose: rows written to another bucket must not cross the wire at all, and a row UPDATED
  // out of the filter must — that asymmetry is what makes permissive row routing measurable.
  await client.collection('rows').subscribe({ filter: eq('bucket', KEEP) }).ready
  // Held open for the run: re-opening per write would bill a stream of `cdopen` frames to the CRDT phase.
  doc = client.collection('docs').open(DOC_ID)
  await doc.ready
  return { rooms }
}

async function runPhase(n: number, body: Record<string, unknown>): Promise<{ ops: number }> {
  const spec = phaseByNumber(n)
  if (!spec || !spec.drivers.includes(NAME)) return { ops: 0 }
  const targets = (body.targets ?? {}) as Record<string, string>
  let ops = 0
  const step = async (fn: () => Promise<unknown>): Promise<void> => {
    await fn()
    ops++
    await pace()
  }

  for (let i = 0; i < OPS; i++) {
    if (n === 1) await step(() => client.ping(payload(n)))
    else if (n === 2 || n === 3) {
      const target = targets[EMIT_TARGET[n] ?? '']
      if (!target) throw new Error(`traffic-lab: phase ${n} has no target connection id`)
      await step(() => client.emitTo({ ...payload(n), target }))
    } else if (n === 4) await step(() => client.broadcastRoom({ ...payload(n), room: ROOM_LOCAL }))
    else if (n === 5) await step(() => client.broadcastRoom({ ...payload(n), room: ROOM_SPREAD }))
    else if (n === 6) await step(() => client.publishTopic(payload(n)))
    else if (n === 7) await step(() => client.busPublish(payload(n)))
    else if (n === 8) {
      // insert into the subscribed bucket, then move half of them out of it
      const id = `row-${i}`
      await step(() => client.collection('rows').insert({ id, bucket: KEEP, n: i, op: nextOp() }))
      if (i % 2 === 0)
        await step(() => client.collection('rows').update({ id, bucket: DROP, n: i, op: nextOp() }))
    } else if (n === 9) {
      if (!doc) throw new Error('traffic-lab: CRDT phase ran before setup opened the document')
      await step(async () => doc!.update({ cells: { [`c${i}`]: i } }))
    } else if (n === 10) {
      await step(() => client.joinRoom({ room: ROOM_CHURN }))
      await step(() => client.leaveRoom({ room: ROOM_CHURN }))
    } else break
  }
  return { ops }
}

serveControl(CTRL_PORT, {
  '/ready': () => ({ ok: connected, client: NAME, connId, node: NODE_URL }),
  '/setup': async () => ({ ok: true, client: NAME, ...(await setup()) }),
  '/stamp': (body) => {
    sampleNic(rec)
    // `null` closes the run out; Number(null) is 0, which would silently bill the tail to the idle phase.
    rec.setPhase(body.phase === null ? null : Number(body.phase))
    return { ok: true, client: NAME }
  },
  '/phase': async (body) => runPhase(Number(body.phase), body),
  '/flush': () => {
    sampleNic(rec)
    return { ok: true, client: NAME, ...rec.flush() }
  },
})

console.log(`[${NAME}] traffic-lab client · control :${CTRL_PORT} · dialing ${NODE_URL}`)
