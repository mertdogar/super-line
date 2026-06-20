import type { ConnDescriptor, NodeStat, NodeView } from '@super-line/core'

// brand-adjacent palette; roles map to a stable color by hash
const ROLE_COLORS = ['#22d3ee', '#a78bfa', '#f472b6', '#facc15', '#34d399', '#fb923c', '#60a5fa', '#f87171']

export function roleColor(role: string): string {
  let h = 0
  for (let i = 0; i < role.length; i++) h = (h * 31 + role.charCodeAt(i)) >>> 0
  return ROLE_COLORS[h % ROLE_COLORS.length] ?? ROLE_COLORS[0]!
}

export interface GraphNode {
  id: string
  kind: 'bus' | 'server' | 'conn'
  x: number
  y: number
  label: string
  role?: string
  userId?: string
  alive?: boolean
  connCount?: number
  rooms?: string[]
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: 'conn' | 'bus'
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Connections dropped past the soft render cap. */
  truncated: number
}

export const BUS_ID = '__bus'
export const RENDER_CAP = 500
const R_SERVER = 320
const R_CONN = 160

/**
 * Build a hub-and-spoke topology graph: the bus (Adapter) at the center, server
 * nodes around it, and each connection around its owning node. A single node has
 * no bus. Connections beyond {@link RENDER_CAP} are dropped (reported as `truncated`).
 */
export function buildGraph(
  topology: NodeStat[],
  connections: ConnDescriptor[],
  node: NodeView | null,
): Graph {
  const serverIds: string[] = []
  const seen = new Set<string>()
  for (const n of topology) {
    if (!seen.has(n.nodeId)) {
      seen.add(n.nodeId)
      serverIds.push(n.nodeId)
    }
  }
  if (node && !seen.has(node.nodeId)) {
    seen.add(node.nodeId)
    serverIds.push(node.nodeId)
  }

  const statByNode = new Map(topology.map((n) => [n.nodeId, n]))
  const showBus = serverIds.length >= 2

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  if (showBus) nodes.push({ id: BUS_ID, kind: 'bus', x: 0, y: 0, label: 'Adapter · bus' })

  const capped = connections.slice(0, RENDER_CAP)
  const truncated = Math.max(0, connections.length - capped.length)
  const connsByNode = new Map<string, ConnDescriptor[]>()
  for (const c of capped) {
    const arr = connsByNode.get(c.nodeId) ?? []
    arr.push(c)
    connsByNode.set(c.nodeId, arr)
  }

  serverIds.forEach((sid, i) => {
    const angle = serverIds.length === 1 ? 0 : (i / serverIds.length) * Math.PI * 2 - Math.PI / 2
    const sx = showBus ? Math.cos(angle) * R_SERVER : 0
    const sy = showBus ? Math.sin(angle) * R_SERVER : 0
    const stat = statByNode.get(sid)
    nodes.push({
      id: sid,
      kind: 'server',
      x: sx,
      y: sy,
      label: sid.slice(0, 8),
      alive: stat?.alive ?? true,
      connCount: stat?.connections ?? connsByNode.get(sid)?.length ?? 0,
    })
    if (showBus) edges.push({ id: `e-bus-${sid}`, source: sid, target: BUS_ID, kind: 'bus' })

    const conns = connsByNode.get(sid) ?? []
    conns.forEach((c, j) => {
      const ca = (j / Math.max(conns.length, 1)) * Math.PI * 2
      nodes.push({
        id: c.id,
        kind: 'conn',
        x: sx + Math.cos(ca) * R_CONN,
        y: sy + Math.sin(ca) * R_CONN,
        label: c.role,
        role: c.role,
        userId: c.userId,
        rooms: c.rooms,
      })
      edges.push({ id: `e-${c.id}`, source: c.id, target: sid, kind: 'conn' })
    })
  })

  return { nodes, edges, truncated }
}

/** All rooms present across the given connections (for the highlight lens). */
export function roomsOf(connections: ConnDescriptor[]): string[] {
  const set = new Set<string>()
  for (const c of connections) for (const r of c.rooms) set.add(r)
  return [...set].sort()
}
