import * as React from 'react'
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { ConnDescriptor, NodeStat, NodeView } from '@super-line/core'
import { buildGraph, type GraphNode, type Highlight } from '@/lib/topology'
import { connLabel, type Directory } from '@/lib/identity'
import { transportColor, transportFamily } from '@/lib/transport'

function labelFor(n: GraphNode, directory: Directory): React.ReactNode {
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
  // identity first when the auth lens has a name for this conn, otherwise the pre-lens role/id rendering
  const { title, subtitle } = connLabel({ id: n.id, role: n.role ?? '', userId: n.userId }, directory)
  return (
    <div className="leading-tight">
      <div className="font-medium">{title}</div>
      <div className="text-[10px] opacity-70">{subtitle}</div>
    </div>
  )
}

/** Does a conn node match the active highlight (by room membership, wire family, or user)? */
function matches(n: GraphNode, h: Highlight): boolean {
  if (h.kind === 'room') return !!n.rooms?.includes(h.value)
  if (h.kind === 'user') return n.userId === h.value
  return transportFamily(n.transport) === h.value
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
    // The hub: a distinct anchor that reads as "live" via a soft cyan signal glow when the node is alive.
    return {
      ...base,
      background: 'var(--color-card)',
      border: `1px solid ${n.alive ? 'color-mix(in oklch, var(--color-primary) 45%, var(--color-border))' : 'var(--color-border)'}`,
      color: 'var(--color-foreground)',
      borderRadius: 12,
      padding: '10px 14px',
      minWidth: 108,
      fontWeight: 500,
      boxShadow: n.alive
        ? '0 0 0 1px color-mix(in oklch, var(--color-primary) 20%, transparent), 0 0 26px -6px color-mix(in oklch, var(--color-primary) 55%, transparent)'
        : 'none',
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
    padding: '5px 10px',
    boxShadow: highlighted ? `0 0 0 1.5px ${color}, 0 0 16px -4px ${color}` : 'none',
  }
}

export function TopologyGraph({
  topology,
  connections,
  node,
  highlight,
  directory,
  selectedId,
  onSelect,
}: {
  topology: NodeStat[]
  connections: ConnDescriptor[]
  node: NodeView | null
  highlight: Highlight | null
  directory: Directory
  selectedId: string | null
  onSelect: (sel: { id: string; kind: GraphNode['kind'] } | null) => void
}): React.JSX.Element {
  const prefersReduced = React.useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(prefers-reduced-motion: reduce)')
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    () => false,
  )

  const { nodes, edges, truncated } = React.useMemo(() => {
    const g = buildGraph(topology, connections, node)
    const nodes: Node[] = g.nodes.map((n) => {
      const base = styleFor(n, highlight)
      return {
        id: n.id,
        position: { x: n.x, y: n.y },
        data: { label: labelFor(n, directory), kind: n.kind },
        style:
          n.id === selectedId
            ? {
                ...base,
                boxShadow:
                  '0 0 0 2px var(--color-primary), 0 0 20px -4px color-mix(in oklch, var(--color-primary) 60%, transparent)',
              }
            : base,
        draggable: true,
        connectable: false,
        selectable: false,
      }
    })
    // Edges are the wire: a faint cyan signal converging on the hub. Gently animated (the "realtime made
    // visible" motif), held static under reduced-motion. The bus link is brighter — it carries every node.
    const edges: Edge[] = g.edges.map((e) => {
      const isBus = e.kind === 'bus'
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        animated: !prefersReduced,
        style: {
          stroke: 'var(--color-primary)',
          strokeOpacity: isBus ? 0.6 : 0.3,
          strokeWidth: isBus ? 1.5 : 1.25,
        },
      }
    })
    return { nodes, edges, truncated: g.truncated }
  }, [topology, connections, node, highlight, directory, prefersReduced, selectedId])

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.28 }}
        nodesConnectable={false}
        edgesFocusable={false}
        minZoom={0.2}
        onNodeClick={(_, n) => onSelect({ id: n.id, kind: (n.data as { kind: GraphNode['kind'] }).kind })}
        onPaneClick={() => onSelect(null)}
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
