import { describe, expect, it } from 'vitest'
import type { ConnDescriptor, NodeStat, NodeView } from '@super-line/core'
import { BUS_ID, buildGraph, roomsOf } from '../src/lib/topology.js'

const conn = (id: string, nodeId: string, role: string, rooms: string[] = []): ConnDescriptor => ({
  id,
  role,
  nodeId,
  connectedAt: 0,
  rooms,
})

describe('buildGraph', () => {
  it('single node: no bus, conns hang off the node', () => {
    const topo: NodeStat[] = [{ nodeId: 'nodeA', connections: 2, rooms: 1, alive: true }]
    const conns = [conn('c1', 'nodeA', 'user', ['lobby']), conn('c2', 'nodeA', 'agent')]
    const g = buildGraph(topo, conns, null)

    expect(g.nodes.find((n) => n.kind === 'bus')).toBeUndefined()
    expect(g.nodes.filter((n) => n.kind === 'server')).toHaveLength(1)
    expect(g.nodes.filter((n) => n.kind === 'conn')).toHaveLength(2)
    // every conn has an edge to its node; no bus edges
    expect(g.edges.filter((e) => e.kind === 'conn')).toHaveLength(2)
    expect(g.edges.filter((e) => e.kind === 'bus')).toHaveLength(0)
  })

  it('multi node: bus hub with node→bus edges', () => {
    const topo: NodeStat[] = [
      { nodeId: 'nodeA', connections: 1, rooms: 0, alive: true },
      { nodeId: 'nodeB', connections: 1, rooms: 0, alive: true },
    ]
    const conns = [conn('c1', 'nodeA', 'user'), conn('c2', 'nodeB', 'user')]
    const g = buildGraph(topo, conns, null)

    expect(g.nodes.find((n) => n.id === BUS_ID)?.kind).toBe('bus')
    expect(g.nodes.filter((n) => n.kind === 'server')).toHaveLength(2)
    expect(g.edges.filter((e) => e.kind === 'bus')).toHaveLength(2) // each node → bus
    expect(g.edges.filter((e) => e.target === BUS_ID)).toHaveLength(2)
  })

  it('includes the connected node even when it has no connections', () => {
    const node: NodeView = { nodeId: 'idle', rooms: [], topics: [] }
    const g = buildGraph([], [], node)
    expect(g.nodes.filter((n) => n.kind === 'server').map((n) => n.id)).toEqual(['idle'])
  })

  it('caps connections and reports the overflow', () => {
    const conns = Array.from({ length: 510 }, (_, i) => conn(`c${i}`, 'nodeA', 'user'))
    const g = buildGraph([{ nodeId: 'nodeA', connections: 510, rooms: 0, alive: true }], conns, null)
    expect(g.nodes.filter((n) => n.kind === 'conn')).toHaveLength(500)
    expect(g.truncated).toBe(10)
  })

  it('roomsOf collects distinct rooms', () => {
    expect(roomsOf([conn('c1', 'n', 'user', ['a', 'b']), conn('c2', 'n', 'user', ['b', 'c'])])).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})
