import { describe, expect, it } from 'vitest'
import type { ConnDescriptor } from '@super-line/core'
import { eventColor, flavorColor, summarizeEvent } from '../src/lib/events.js'

const descriptor: ConnDescriptor = {
  id: 'abcdef1234',
  role: 'user',
  nodeId: 'node1234',
  connectedAt: 0,
  rooms: [],
}

describe('event helpers', () => {
  it('summarizes each event variant', () => {
    expect(summarizeEvent({ type: 'connect', descriptor })).toContain('user')
    expect(summarizeEvent({ type: 'disconnect', connId: 'abcdef12', nodeId: 'node1234' })).toContain('abcdef12')
    expect(summarizeEvent({ type: 'room.add', connId: 'abcdef12', room: 'lobby' })).toContain('lobby')
    expect(summarizeEvent({ type: 'topic.sub', connId: 'abcdef12', topic: 'feed' })).toContain('feed')
  })

  it('maps event types and flavors to colors', () => {
    expect(eventColor('connect')).toBe('bg-primary')
    expect(eventColor('disconnect')).toBe('bg-destructive')
    expect(eventColor('room.add')).toContain('violet')
    expect(flavorColor('topic')).toMatch(/^#/)
  })
})
