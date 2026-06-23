import * as React from 'react'
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ConnDescriptor, NodeStat, NodeView } from '@super-line/core'
import { buildGraph, type GraphNode, type Highlight } from '@/lib/topology'
import { transportColor, transportFamily } from '@/lib/transport'

function labelFor(n: GraphNode): React.ReactNode {
  if (n.kind === 'bus') return 'Adapter · bus'
  if (n.kind === 'server') {
    return (
      <div className="text-center leading-tight">
        <div className="font-semibold">{n.label}</div>
        <div className="text-[10px] opacity-70">
          {n.connCount} conns{n.breakdown ? ` · ${n.breakdown}` : ''}
          {n.alive ? '' : ' · dead'}
        </div>
      </div>
    )
  }
  return (
    <div className="leading-tight">
      <div className="font-medium">{n.role}</div>
      {n.userId ? <div className="text-[10px] opacity-70">{n.userId}</div> : null}
    </div>
  )
}

/** Does a conn node match the active highlight (by room membership or wire family)? */
function matches(n: GraphNode, h: Highlight): boolean {
  return h.kind === 'room' ? !!n.rooms?.includes(h.value) : transportFamily(n.transport) === h.value
}

function styleFor(n: GraphNode, highlight: Highlight | null): React.CSSProperties {
  const dim = highlight !== null && n.kind === 'conn' && !matches(n, highlight)
  const base: React.CSSProperties = { fontSize: 11, opacity: dim ? 0.16 : 1, transition: 'opacity 120ms' }
  if (n.kind === 'bus') {
    return {
      ...base,
      background: 'var(--color-card)',
      border: '1px solid var(--color-primary)',
      color: 'var(--color-primary)',
      borderRadius: 999,
      padding: '8px 16px',
      fontWeight: 600,
    }
  }
  if (n.kind === 'server') {
    return {
      ...base,
      background: 'var(--color-card)',
      border: '1px solid var(--color-border)',
      color: 'var(--color-foreground)',
      borderRadius: 12,
      padding: '8px 12px',
      minWidth: 96,
    }
  }
  const color = transportColor(n.transport)
  const highlighted = highlight !== null && n.kind === 'conn' && matches(n, highlight)
  return {
    ...base,
    background: `${color}1f`,
    border: `1px solid ${color}`,
    color: 'var(--color-foreground)',
    borderRadius: 8,
    padding: '4px 9px',
    boxShadow: highlighted ? `0 0 0 2px ${color}` : 'none',
  }
}

export function TopologyGraph({
  topology,
  connections,
  node,
  highlight,
}: {
  topology: NodeStat[]
  connections: ConnDescriptor[]
  node: NodeView | null
  highlight: Highlight | null
}): React.JSX.Element {
  const { nodes, edges, truncated } = React.useMemo(() => {
    const g = buildGraph(topology, connections, node)
    const nodes: Node[] = g.nodes.map((n) => ({
      id: n.id,
      position: { x: n.x, y: n.y },
      data: { label: labelFor(n) },
      style: styleFor(n, highlight),
      draggable: true,
      connectable: false,
      selectable: false,
    }))
    const edges: Edge[] = g.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.kind === 'bus',
      style: {
        stroke: e.kind === 'bus' ? 'var(--color-primary)' : 'var(--color-border)',
        strokeWidth: e.kind === 'bus' ? 1.5 : 1,
      },
    }))
    return { nodes, edges, truncated: g.truncated }
  }, [topology, connections, node, highlight])

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.2}
      >
        <Background color="#2b2b35" gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {truncated > 0 ? (
        <div className="absolute left-3 top-3 rounded-md border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground">
          showing 500 of {500 + truncated} connections · Control Center targets small clusters
        </div>
      ) : null}
    </div>
  )
}
