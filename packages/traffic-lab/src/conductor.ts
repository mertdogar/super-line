import { call, waitReady } from './control.js'
import { adapterKind, num, str } from './env.js'

/**
 * The run driver. It gates on readiness before anything is measured, walks the phase list, and leaves a
 * quiet gap between phases so background chatter is attributable. It talks HTTP only — see control.ts.
 */
const NODES = str('NODES').split(',').filter(Boolean)
const CLIENTS = str('CLIENTS').split(',').filter(Boolean)
const CTRL_PORT = num('CTRL_PORT', 8900)
const READY_TIMEOUT = num('READY_TIMEOUT_MS', 120_000)
const KIND = adapterKind()

const base = (host: string): string => `http://${host}:${CTRL_PORT}`

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
  console.log(`[conductor] waiting for ${NODES.length} nodes (adapter=${KIND})`)
  // A libp2p node is only ready once its gossipsub mesh has every peer: measuring before the mesh forms
  // would record publishes that were dropped for a reason that has nothing to do with fan-out design.
  const wantPeers = KIND === 'libp2p' ? NODES.length - 1 : 0
  const nodes = await Promise.all(
    NODES.map((n) => waitReady<NodeReady>(base(n), READY_TIMEOUT, (s) => s.ok === true && s.peers >= wantPeers)),
  )
  for (const n of nodes) console.log(`[conductor] node ready: ${n.node} (peers=${n.peers})`)

  console.log(`[conductor] waiting for ${CLIENTS.length} clients`)
  const clients = await Promise.all(
    CLIENTS.map((c) => waitReady<ClientReady>(base(c), READY_TIMEOUT, (s) => s.ok === true && s.connId !== '')),
  )
  for (const c of clients) console.log(`[conductor] client ready: ${c.client} (${c.connId})`)

  // Nodes are stamped with the phase before the clients act, so a frame produced by the phase can never be
  // recorded under the previous one.
  const stamp = async (phase: number | null): Promise<void> => {
    await Promise.all([...NODES, ...CLIENTS].map((a) => call(base(a), '/phase', { phase })))
  }

  // Phase 0 smoke: one request per client, proving the whole stack round-trips.
  await stamp(1)
  const results = await Promise.all(CLIENTS.map((c) => call<{ ops: number }>(base(c), '/phase', { phase: 1 })))
  const total = results.reduce((a, r) => a + r.ops, 0)
  console.log(`[conductor] smoke complete — ${total} ops across ${CLIENTS.length} clients`)

  await new Promise((r) => setTimeout(r, 1500)) // let in-flight fan-out land before the dumps are closed
  const flushed = await Promise.all(
    [...NODES, ...CLIENTS].map(async (a) => ({ actor: a, ...(await call<{ written: number }>(base(a), '/flush')) })),
  )
  for (const f of flushed) console.log(`[conductor] dump ${f.actor}: ${f.written} records`)
}

await main()
