import { describe, expect, it } from 'vitest'
import type { ConnDescriptor } from '@super-line/core'
import { eventColor, flavorColor, summarizeEvent } from '../src/lib/events.js'

const descriptor: ConnDescriptor = {
  id: 'abcdef1234',
  role: 'user',
  nodeId: 'node1234',
  nodeName: 'node-1',
  userId: 'ada',
  connectedAt: 0,
  rooms: ['lobby'],
}

describe('event helpers', () => {
  it('summarizes each event variant', () => {
    expect(summarizeEvent({ type: 'connect', descriptor })).toContain('ada (user)')
    expect(summarizeEvent({ type: 'connect', descriptor })).toContain('node-1') // friendly node name
    expect(summarizeEvent({ type: 'disconnect', connId: 'abcdef12', nodeId: 'node1234' })).toContain('abcdef12')
    expect(summarizeEvent({ type: 'room.add', connId: 'abcdef12', room: 'lobby' })).toContain('lobby')
    expect(summarizeEvent({ type: 'topic.sub', connId: 'abcdef12', topic: 'feed' })).toContain('feed')
  })

  it('resolves connId/nodeId to friendly names when given a resolver', () => {
    const resolver = {
      conn: (id: string) => (id === descriptor.id ? descriptor : undefined),
      nodeName: (nodeId: string) => (nodeId === 'node1234' ? 'node-1' : nodeId.slice(0, 8)),
    }
    expect(summarizeEvent({ type: 'room.add', connId: 'abcdef1234', room: 'lobby' }, resolver)).toBe(
      'ada (user) · lobby',
    )
    // disconnect carries userId on the event even after the conn is purged
    expect(
      summarizeEvent({ type: 'disconnect', connId: 'gone', nodeId: 'node1234', userId: 'grace' }, resolver),
    ).toBe('grace on node-1')
  })

  it('maps event types and flavors to colors', () => {
    expect(eventColor('connect')).toBe('bg-primary')
    expect(eventColor('disconnect')).toBe('bg-destructive')
    expect(eventColor('room.add')).toContain('violet')
    expect(flavorColor('topic')).toMatch(/^#/)
  })
})
