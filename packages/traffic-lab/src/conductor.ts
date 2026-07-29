import { call, waitReady } from './control.js'
import { adapterKind, num, runId, str } from './env.js'
import { DOC_ID, PHASES } from './phases.js'

/**
 * The run driver. It gates on readiness before anything is measured, walks the phase list, and leaves a
 * quiet gap between phases so background chatter stays attributable. It talks HTTP only (see control.ts),
 * so nothing it does appears in the traffic being measured.
 */
const NODES = str('NODES').split(',').filter(Boolean)
const CLIENTS = str('CLIENTS').split(',').filter(Boolean)
const CTRL_PORT = num('CTRL_PORT', 8900)
const READY_TIMEOUT = num('READY_TIMEOUT_MS', 120_000)
const GAP_MS = num('PHASE_GAP_MS', 2500)
const KIND = adapterKind()

const base = (host: string): string => `http://${host}:${CTRL_PORT}`
const ALL = (): string[] => [...NODES, ...CLIENTS]
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface NodeReady {
  ok: boolean
  node: string
  peers: number
}
interface ClientReady {
  ok: boolean
  client: string
  connId: string
}

async function main(): Promise<void> {
  console.log(`[conductor] run ${runId()} — ${NODES.length} nodes, ${CLIENTS.length} clients, adapter=${KIND}`)

  // A libp2p node is only ready once its mesh has every peer: measuring before the mesh forms would record
  // publishes dropped for a reason that has nothing to do with fan-out design.
  const wantPeers = KIND === 'libp2p' ? NODES.length - 1 : 0
  const nodes = await Promise.all(
    NODES.map((n) => waitReady<NodeReady>(base(n), READY_TIMEOUT, (s) => s.ok === true && s.peers >= wantPeers)),
  )
  for (const n of nodes) console.log(`[conductor] node ready: ${n.node} (peers=${n.peers})`)

  const clients = await Promise.all(
    CLIENTS.map((c) => waitReady<ClientReady>(base(c), READY_TIMEOUT, (s) => s.ok === true && s.connId !== '')),
  )
  const targets: Record<string, string> = {}
  for (const c of clients) {
    targets[c.client] = c.connId
    console.log(`[conductor] client ready: ${c.client} (${c.connId})`)
  }

  // CRDT creation is server-authoritative AND node-local — a create does not relay, and a node that never
  // ran one answers `open` with NOT_FOUND forever. Since clients here are pinned across all three nodes,
  // every node has to be seeded.
  await Promise.all(NODES.map((n) => call(base(n), '/seed', { docs: [DOC_ID] })))
  await sleep(500)

  // Rooms, topic subscriptions, the collection subscription and the document open all happen OUTSIDE any
  // measured phase — otherwise every phase would carry its own setup traffic.
  await Promise.all(CLIENTS.map((c) => call(base(c), '/setup')))
  await sleep(GAP_MS)

  for (const spec of PHASES) {
    // Every actor is stamped before any client acts, so a frame produced by a phase can never land in the
    // previous one. Stamping is a separate route from running — one that also ran would double every phase.
    await Promise.all(ALL().map((a) => call(base(a), '/stamp', { phase: spec.n })))
    const started = Date.now()
    if (spec.holdMs) await sleep(spec.holdMs)
    const results = await Promise.all(
      CLIENTS.map((c) => call<{ ops: number }>(base(c), '/phase', { phase: spec.n, targets })),
    )
    const ops = results.reduce((a, r) => a + r.ops, 0)
    console.log(`[conductor] phase ${spec.n} ${spec.name}: ${ops} ops in ${Date.now() - started}ms — ${spec.detail}`)
    await sleep(GAP_MS) // quiet gap: in-flight fan-out lands, and background chatter is measured alone
  }

  // Stamp the tail as "no phase" so anything still arriving is not billed to phase 10.
  await Promise.all(ALL().map((a) => call(base(a), '/stamp', { phase: null })))
  await sleep(1500)

  const flushed = await Promise.all(
    ALL().map(async (a) => ({ actor: a, ...(await call<{ written: number }>(base(a), '/flush')) })),
  )
  const total = flushed.reduce((a, f) => a + f.written, 0)
  for (const f of flushed) console.log(`[conductor] dump ${f.actor}: ${f.written} records`)
  console.log(`[conductor] run complete — ${total} records`)
}

await main()
