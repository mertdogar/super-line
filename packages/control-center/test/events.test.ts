import { describe, expect, it } from 'vitest'
import type { ConnDescriptor, InspectorEnvelope, InspectorEvent } from '@super-line/core'
import {
  eventCategory,
  eventColor,
  eventPayload,
  eventWire,
  flavorColor,
  formatBytes,
  formatDuration,
  latencyOf,
  requestTimes,
  summarizeEvent,
  type FeedResolver,
} from '../src/lib/events.js'

const envelope = (event: InspectorEvent, ts: number, byteSize?: number): InspectorEnvelope => ({
  event,
  ts,
  byteSize,
  originNodeId: 'node1234',
})

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

  it('formats byte sizes, em-dash for no payload', () => {
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('pairs responses to requests by reqId, even with same-name concurrency', () => {
    const c = 'conn1'
    const envs: InspectorEnvelope[] = [
      // two overlapping same-name requests, distinguished only by reqId
      envelope({ type: 'msg.request', connId: c, role: 'user', name: 'echo', input: {}, reqId: 1 }, 100),
      envelope({ type: 'msg.request', connId: c, role: 'user', name: 'echo', input: {}, reqId: 2 }, 150),
      envelope({ type: 'msg.response', connId: c, name: 'echo', ok: true, reqId: 2 }, 210),
      envelope({ type: 'msg.response', connId: c, name: 'echo', ok: true, reqId: 1 }, 200),
    ]
    const reqTimes = requestTimes(envs)
    expect(latencyOf(envs[3]!, reqTimes)).toBe(100) // reqId 1: 200 − 100
    expect(latencyOf(envs[2]!, reqTimes)).toBe(60) // reqId 2: 210 − 150, not cross-paired
    expect(latencyOf(envs[0]!, reqTimes)).toBeUndefined() // a request row has no latency

    // a response whose request isn't in the window → unknown latency
    const orphan = envelope({ type: 'msg.response', connId: c, name: 'echo', ok: true, reqId: 9 }, 300)
    expect(latencyOf(orphan, requestTimes([orphan]))).toBeUndefined()
  })

  it('formats elapsed durations compactly', () => {
    const now = 1_000_000_000
    expect(formatDuration(now - 5_000, now)).toBe('5s')
    expect(formatDuration(now - 14 * 60_000, now)).toBe('14m')
    expect(formatDuration(now - (2 * 3600_000 + 3 * 60_000), now)).toBe('2h 3m')
    expect(formatDuration(now + 5_000, now)).toBe('0s') // clamps future to 0
  })

  it('summarizes message events and exposes their payloads', () => {
    const resolver = {
      conn: (id: string) => (id === descriptor.id ? descriptor : undefined),
      nodeName: () => 'node-1',
    }
    const req = { type: 'msg.request', connId: descriptor.id, role: 'user', name: 'send', input: { text: 'hi' }, reqId: 1 } as const
    expect(summarizeEvent(req, resolver)).toBe('ada (user) → send')
    expect(eventPayload(req)).toEqual({ text: 'hi' })

    const res = { type: 'msg.response', connId: descriptor.id, name: 'send', ok: false, error: { code: 'BOOM', message: 'x' }, reqId: 1 } as const
    expect(summarizeEvent(res, resolver)).toContain('BOOM')
    expect(eventPayload(res)).toEqual({ code: 'BOOM', message: 'x' })

    expect(summarizeEvent({ type: 'msg.broadcast', room: 'lobby', name: 'message', data: {} })).toBe('lobby ⇒ message')
    expect(summarizeEvent({ type: 'msg.publish', topic: 'presence', data: {} })).toBe('presence')
    expect(eventPayload({ type: 'connect', descriptor })).toBeUndefined() // lifecycle: nothing to expand
  })

  it('attributes feed rows to a wire (and leaves the unattributable ones blank)', () => {
    const libp2pConn: ConnDescriptor = { ...descriptor, id: 'p2p1', transport: 'libp2p' }
    const resolver: FeedResolver = {
      conn: (id) => (id === libp2pConn.id ? libp2pConn : undefined),
      nodeName: () => 'node-1',
      roomWires: (room) =>
        room === 'lobby'
          ? [
              { family: 'websocket', count: 3 },
              { family: 'http', count: 2 },
            ]
          : [],
    }

    // inbound request → the originating conn's wire
    expect(eventWire({ type: 'msg.request', connId: 'p2p1', role: 'user', name: 'send', input: {}, reqId: 1 }, resolver)).toEqual({
      kind: 'one',
      label: 'libp2p',
      color: expect.stringMatching(/^#/),
    })
    // connect → the descriptor's wire, sub-mode preserved
    expect(eventWire({ type: 'connect', descriptor: { ...descriptor, transport: 'sse' } })).toMatchObject({
      kind: 'one',
      label: 'HTTP · SSE',
    })
    // broadcast → the room members' wire breakdown
    expect(eventWire({ type: 'msg.broadcast', room: 'lobby', name: 'message', data: {} }, resolver)).toEqual({
      kind: 'many',
      parts: [
        { short: 'ws', count: 3, color: expect.stringMatching(/^#/) },
        { short: 'http', count: 2, color: expect.stringMatching(/^#/) },
      ],
    })
    // unknown conn → no chip
    expect(eventWire({ type: 'msg.request', connId: 'gone', role: 'user', name: 'send', input: {}, reqId: 1 }, resolver)).toBeUndefined()
    // publish (topic subs unknown) + serverRequest/serverReply (adapter axis) → intentionally unattributed
    expect(eventWire({ type: 'msg.publish', topic: 'presence', data: {} }, resolver)).toBeUndefined()
    expect(eventWire({ type: 'msg.serverRequest', target: 'node2', name: 'sync', input: {}, reqId: 1 }, resolver)).toBeUndefined()
  })

  it('buckets events into feed categories', () => {
    expect(eventCategory('connect')).toBe('lifecycle')
    expect(eventCategory('room.add')).toBe('lifecycle')
    expect(eventCategory('msg.request')).toBe('requests')
    expect(eventCategory('msg.serverReply')).toBe('requests')
    expect(eventCategory('msg.broadcast')).toBe('events')
    expect(eventCategory('msg.publish')).toBe('events')
  })

  it('maps event types and flavors to colors', () => {
    expect(eventColor('connect')).toBe('bg-primary')
    expect(eventColor('disconnect')).toBe('bg-destructive')
    expect(eventColor('room.add')).toContain('violet')
    expect(eventColor('msg.request')).toContain('cyan')
    expect(eventColor('msg.broadcast')).toContain('sky')
    expect(eventColor('store.write')).toContain('orange')
    expect(flavorColor('topic')).toMatch(/^#/)
  })

  it('handles store events (summary, category, payload, wire)', () => {
    const resolver: FeedResolver = {
      conn: (id) => (id === descriptor.id ? descriptor : undefined),
      nodeName: () => 'node-1',
    }
    const write = { type: 'store.write', store: 'scene', id: 'd1', origin: 'w1', connId: descriptor.id, data: { v: 2 } } as const
    expect(summarizeEvent(write, resolver)).toBe('scene/d1')
    expect(eventPayload(write)).toEqual({ v: 2 })
    expect(eventWire(write, resolver)).toMatchObject({ kind: 'one' }) // attributed to the writer's conn

    const grant = { type: 'store.grant', store: 'scene', id: 'd1', principal: 'ada', perms: { read: true, write: false } } as const
    expect(summarizeEvent(grant)).toBe('scene/d1 +ada')
    expect(eventPayload(grant)).toEqual({ read: true, write: false })
    expect(eventWire(grant)).toBeUndefined() // server-side, no wire

    const sub = { type: 'store.subscribe', connId: descriptor.id, store: 'scene', id: 'd1' } as const
    expect(summarizeEvent(sub, resolver)).toBe('ada (user) · scene/d1')

    for (const t of ['store.write', 'store.grant', 'store.revoke', 'store.subscribe', 'store.unsubscribe'] as const) {
      expect(eventCategory(t)).toBe('stores')
    }
  })
})
