import fs from 'node:fs'
import path from 'node:path'
import type { LabRecord } from '../tap/record.js'

export interface RunData {
  runId: string
  /** Every record from every actor, keyed by actor. */
  byActor: Map<string, LabRecord[]>
  /** Nodes only (an actor that reported a libp2p peer id or a node name). */
  nodes: string[]
  clients: string[]
  /** gossipsub peer id → node name, so an arrival can name the node that published it. */
  peerToNode: Map<string, string>
  adapter: string
  inspector: boolean
}

export function loadRun(dir: string): RunData {
  const runId = path.basename(dir)
  const byActor = new Map<string, LabRecord[]>()
  const peerToNode = new Map<string, string>()
  const nodes: string[] = []
  const clients: string[] = []
  let adapter = 'unknown'
  let inspector = false

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'))) {
    const actor = file.replace(/\.ndjson$/, '')
    const records: LabRecord[] = []
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      records.push(JSON.parse(line) as LabRecord)
    }
    byActor.set(actor, records)
    const meta = records.find((r) => r.layer === 'meta')
    if (meta && meta.layer === 'meta') {
      if (meta.node) {
        nodes.push(actor)
        adapter = meta.adapter
        inspector = meta.inspector || inspector
        if (meta.peerId) peerToNode.set(meta.peerId, actor)
      } else clients.push(actor)
    }
  }
  nodes.sort()
  clients.sort()
  return { runId, byActor, nodes, clients, peerToNode, adapter, inspector }
}

export function loadAllRuns(runsDir: string): RunData[] {
  if (!fs.existsSync(runsDir)) return []
  return fs
    .readdirSync(runsDir)
    .map((name) => path.join(runsDir, name))
    .filter((p) => fs.statSync(p).isDirectory())
    .filter((p) => fs.readdirSync(p).some((f) => f.endsWith('.ndjson')))
    .map(loadRun)
    .sort((a, b) => a.runId.localeCompare(b.runId))
}
