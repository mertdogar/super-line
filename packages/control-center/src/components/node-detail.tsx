import * as React from 'react'
import type { ConnDescriptor, NodeStat, NodeView } from '@super-line/core'
import { connLabel, shortId, type Directory } from '@/lib/identity'
import { breakdownLabel } from '@/lib/transport'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      {children}
    </div>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }): React.JSX.Element {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <Badge key={it} variant="muted">
          {it}
        </Badge>
      ))}
    </div>
  )
}

/**
 * Detail panel for a server (node) picked in the topology graph — the node-scoped analog of ConnDetail.
 * Node-local rooms/topics are only available for the inspected node; other nodes show basic stats. The
 * connection list drills back into ConnDetail via `onSelectConn`.
 */
export function NodeDetail({
  nodeId,
  topology,
  node,
  connections,
  directory,
  onClose,
  onSelectConn,
}: {
  nodeId: string | null
  topology: NodeStat[]
  node: NodeView | null
  connections: ConnDescriptor[]
  directory: Directory
  onClose: () => void
  onSelectConn: (id: string) => void
}): React.JSX.Element | null {
  if (!nodeId) return null
  const stat = topology.find((n) => n.nodeId === nodeId)
  const isInspected = node?.nodeId === nodeId
  const conns = connections.filter((c) => c.nodeId === nodeId)
  const name = stat?.nodeName ?? (isInspected ? node?.nodeName : undefined) ?? shortId(nodeId)
  const alive = stat?.alive ?? true
  const breakdown = breakdownLabel(conns)

  return (
    <div className="absolute inset-0 z-10 flex">
      <button type="button" className="flex-1 bg-black/40" onClick={onClose} aria-label="Close detail" />
      <div className="w-104 overflow-auto border-l bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{name}</h3>
              <Badge variant={alive ? 'default' : 'muted'}>{alive ? 'alive' : 'dead'}</Badge>
              {isInspected ? <Badge variant="muted">inspected</Badge> : null}
            </div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">Node {shortId(nodeId)}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            close
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge variant="muted">{stat?.connections ?? conns.length} connections</Badge>
          {breakdown ? <Badge variant="muted">{breakdown}</Badge> : null}
        </div>

        {isInspected ? (
          <>
            <Section title="rooms">
              <Chips items={node?.rooms ?? []} empty="no rooms on this node" />
            </Section>
            <Section title="topics · this node">
              <Chips items={node?.topics ?? []} empty="no topics on this node" />
            </Section>
          </>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">
            Point the Control Center at this node to inspect its rooms and topics.
          </p>
        )}

        <Section title={`connections · ${conns.length}`}>
          {conns.length === 0 ? (
            <p className="text-xs text-muted-foreground">no connections on this node</p>
          ) : (
            <div className="flex flex-col gap-1">
              {conns.map((c) => {
                const { title, subtitle } = connLabel({ id: c.id, role: c.role, userId: c.userId }, directory)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onSelectConn(c.id)}
                    className="flex items-center justify-between gap-2 rounded-md border bg-card/40 px-3 py-2 text-left transition-colors hover:bg-accent/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{title}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{c.id.slice(0, 6)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
