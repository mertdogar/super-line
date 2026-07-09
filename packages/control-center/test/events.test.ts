import { describe, expect, it } from 'vitest'
import type { ConnDescriptor, InspectorEnvelope, InspectorEvent } from '@super-line/core'
import {
  barFraction,
  emptyFilters,
  eventCategory,
  eventColor,
  eventPayload,
  eventWire,
  eventWireFamilies,
  exportCsv,
  exportJson,
  exportJsonl,
  exportRecord,
  filtersActive,
  flavorColor,
  formatBytes,
  formatDuration,
  latencyColor,
  sizeColor,
  latencyMsToSlider,
  latencyOf,
  latencySliderToMs,
  matchesFilters,
  MAX_LATENCY_MS,
  MAX_SIZE_BYTES,
  requestTimes,
  sizeBytesToSlider,
  sizeSliderToBytes,
  sliderToLatencyFilter,
  sliderToSizeFilter,
  summarizeEvent,
  windowAnchor,
  wireLabel,
  type FeedResolver,
  type RowMatch,
} from '../src/lib/events.js'
import type { TransportFamily } from '../src/lib/transport.js'

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

  it('heatmap colors bucket latency and size by absolute magnitude', () => {
    // latency: <10 green, 10–30 lime, 30–100 yellow, 100–500 orange, ≥500 red (boundaries are band starts)
    expect(latencyColor(5)).toBe('#4ade80')
    expect(latencyColor(10)).toBe('#a3e635')
    expect(latencyColor(50)).toBe('#facc15')
    expect(latencyColor(300)).toBe('#fb923c')
    expect(latencyColor(500)).toBe('#f87171')
    expect(latencyColor(9999)).toBe('#f87171')
    // size: <512 / 4K / 32K / 256K
    expect(sizeColor(100)).toBe('#4ade80')
    expect(sizeColor(512)).toBe('#a3e635')
    expect(sizeColor(10_000)).toBe('#facc15')
    expect(sizeColor(100_000)).toBe('#fb923c')
    expect(sizeColor(1_000_000)).toBe('#f87171')
  })

  it('barFraction clamps to 0..1 and guards an empty/zero max', () => {
    expect(barFraction(50, 200)).toBe(0.25)
    expect(barFraction(300, 200)).toBe(1) // clamp over
    expect(barFraction(50, 0)).toBe(0) // no in-view max → no fill (no divide-by-zero)
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

  it('pairs the server→client direction by target+reqId, not crossing the client reqId space', () => {
    const envs: InspectorEnvelope[] = [
      // server→client request to a conn, plus a client→server request that happens to reuse reqId 1
      envelope({ type: 'msg.serverRequest', target: 'connX', name: 'sync', input: {}, reqId: 1 }, 100),
      envelope({ type: 'msg.request', connId: 'connX', role: 'user', name: 'echo', input: {}, reqId: 1 }, 120),
      envelope({ type: 'msg.serverReply', target: 'connX', name: 'sync', ok: true, reqId: 1 }, 175),
    ]
    const reqTimes = requestTimes(envs)
    // serverReply pairs to the serverRequest (s:connX:1 = ts 100), not the client request (c:connX:1 = ts 120)
    expect(latencyOf(envs[2]!, reqTimes)).toBe(75)
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
      family: 'libp2p',
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
        { short: 'ws', count: 3, color: expect.stringMatching(/^#/), family: 'websocket' },
        { short: 'http', count: 2, color: expect.stringMatching(/^#/), family: 'http' },
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
    expect(flavorColor('topic')).toMatch(/^#/)
  })
})

describe('feed filters', () => {
  const anchor = 1_000_000
  const row = (over: Partial<RowMatch> = {}): RowMatch => ({
    summary: '',
    families: [],
    nowAnchor: anchor,
    ...over,
  })
  const connectEnv = envelope({ type: 'connect', descriptor }, anchor)
  const reqEnv = envelope(
    { type: 'msg.request', connId: descriptor.id, role: 'user', name: 'send', input: {}, reqId: 1 },
    anchor,
  )

  it('maps the latency slider log-wise and inverts cleanly', () => {
    expect(latencySliderToMs(0)).toBe(1) // far-left ≈ "no minimum"
    expect(latencySliderToMs(1)).toBeCloseTo(MAX_LATENCY_MS, 0) // 10 min
    expect(latencySliderToMs(0.5)).toBeGreaterThan(700) // mid-track is sub-second, not 5 minutes
    expect(latencySliderToMs(0.5)).toBeLessThan(1000)
    expect(latencyMsToSlider(MAX_LATENCY_MS)).toBeCloseTo(1)
    expect(latencyMsToSlider(1000)).toBeCloseTo(Math.log10(1000) / Math.log10(MAX_LATENCY_MS))
  })

  it('latency slider position round-trips stably across the low end (no rounding collapse)', () => {
    // regression: rounding ms in the mapping made positions 1..30 all collapse to position 0
    for (const pos of [0, 1, 5, 30, 250, 500, 1000]) {
      const ms = latencySliderToMs(pos / 1000)
      expect(Math.round(latencyMsToSlider(ms) * 1000)).toBe(pos)
    }
  })

  it('sliderToLatencyFilter: full span = off, any narrowing = a range', () => {
    expect(sliderToLatencyFilter(0, 1000)).toBeNull() // untouched = filter disengaged
    expect(sliderToLatencyFilter(1, 1000)).not.toBeNull() // nudging the min thumb engages it
    expect(sliderToLatencyFilter(0, 999)).not.toBeNull()
    const r = sliderToLatencyFilter(0, 500)!
    expect(r[0]).toBeLessThan(r[1])
  })

  it('size slider maps log-wise (bytes) and full span = off', () => {
    expect(sizeSliderToBytes(0)).toBe(1)
    expect(sizeSliderToBytes(1)).toBeCloseTo(MAX_SIZE_BYTES, 0)
    for (const pos of [0, 1, 30, 500, 1000]) {
      expect(Math.round(sizeBytesToSlider(sizeSliderToBytes(pos / 1000)) * 1000)).toBe(pos) // stable round-trip
    }
    expect(sliderToSizeFilter(0, 1000)).toBeNull()
    expect(sliderToSizeFilter(0, 800)).not.toBeNull()
  })

  it('empty filters pass everything; AND across dimensions', () => {
    const f = emptyFilters()
    expect(matchesFilters(connectEnv, f, row())).toBe(true)
    expect(matchesFilters(reqEnv, f, row())).toBe(true)
  })

  it('text filter matches event type + summary, case-insensitively', () => {
    expect(matchesFilters(reqEnv, { ...emptyFilters(), text: 'send' }, row({ summary: 'ada → send' }))).toBe(true)
    expect(matchesFilters(connectEnv, { ...emptyFilters(), text: 'send' }, row({ summary: 'ada on n1' }))).toBe(false)
    expect(matchesFilters(connectEnv, { ...emptyFilters(), text: 'CONNECT' }, row())).toBe(true) // matches type, any case
  })

  it('filtersActive flags any engaged dimension', () => {
    expect(filtersActive(emptyFilters())).toBe(false)
    expect(filtersActive({ ...emptyFilters(), text: 'x' })).toBe(true)
    expect(filtersActive({ ...emptyFilters(), types: new Set(['msg.request']) })).toBe(true)
    expect(filtersActive({ ...emptyFilters(), wires: new Set<TransportFamily>(['websocket']) })).toBe(true)
    expect(filtersActive({ ...emptyFilters(), windowMs: 60_000 })).toBe(true)
    expect(filtersActive({ ...emptyFilters(), latency: [0, 100] })).toBe(true)
    expect(filtersActive({ ...emptyFilters(), size: [0, 100] })).toBe(true)
  })

  it('type/node filters restrict to the selected set (empty = all)', () => {
    expect(matchesFilters(connectEnv, { ...emptyFilters(), types: new Set(['msg.request']) }, row())).toBe(false)
    expect(matchesFilters(reqEnv, { ...emptyFilters(), types: new Set(['msg.request']) }, row())).toBe(true)
    expect(matchesFilters(connectEnv, { ...emptyFilters(), nodes: new Set(['other']) }, row())).toBe(false)
    expect(matchesFilters(connectEnv, { ...emptyFilters(), nodes: new Set([descriptor.nodeId]) }, row())).toBe(true)
  })

  it('wire filter restricts: rows without a wire family drop when engaged', () => {
    const f = { ...emptyFilters(), wires: new Set<TransportFamily>(['websocket']) }
    expect(matchesFilters(reqEnv, f, row({ families: ['websocket'] }))).toBe(true)
    expect(matchesFilters(reqEnv, f, row({ families: ['libp2p'] }))).toBe(false)
    expect(matchesFilters(reqEnv, f, row({ families: [] }))).toBe(false) // no-wire row dropped
  })

  it('latency filter restricts to in-range latency-bearing rows', () => {
    const f = { ...emptyFilters(), latency: [50, 500] as [number, number] }
    expect(matchesFilters(reqEnv, f, row({ latency: 120 }))).toBe(true)
    expect(matchesFilters(reqEnv, f, row({ latency: 10 }))).toBe(false) // below range
    expect(matchesFilters(reqEnv, f, row({ latency: undefined }))).toBe(false) // no latency → dropped
  })

  it('size filter restricts to in-range rows that have a payload (byteSize)', () => {
    const f = { ...emptyFilters(), size: [100, 1000] as [number, number] }
    const sized = envelope({ type: 'connect', descriptor }, anchor, 500) // byteSize 500
    const small = envelope({ type: 'connect', descriptor }, anchor, 20) // byteSize 20, below range
    const noPayload = envelope({ type: 'connect', descriptor }, anchor) // byteSize undefined
    expect(matchesFilters(sized, f, row())).toBe(true)
    expect(matchesFilters(small, f, row())).toBe(false)
    expect(matchesFilters(noPayload, f, row())).toBe(false) // no payload → dropped when engaged
  })

  it('time window measures back from the anchor', () => {
    const f = { ...emptyFilters(), windowMs: 1000 }
    const fresh = envelope({ type: 'connect', descriptor }, anchor - 500)
    const stale = envelope({ type: 'connect', descriptor }, anchor - 5000)
    expect(matchesFilters(fresh, f, row())).toBe(true)
    expect(matchesFilters(stale, f, row())).toBe(false)
  })

  it('windowAnchor: live measures from wall-clock now, paused from freeze time', () => {
    expect(windowAnchor(false, 123, 999)).toBe(999) // live → now
    expect(windowAnchor(true, 123, 999)).toBe(123) // paused → freeze time
    expect(windowAnchor(true, null, 999)).toBe(999) // paused before any freeze → now
  })

  it('live "last 15s" drops stale events even when they are the newest in the buffer', () => {
    // regression: anchoring to the newest event's ts surfaced hours-old events under a 15s window
    const now = 5_000_000
    const f = { ...emptyFilters(), windowMs: 15_000 }
    const stale = envelope({ type: 'connect', descriptor }, now - 2 * 3_600_000) // 2h old, newest in buffer
    const recent = envelope({ type: 'connect', descriptor }, now - 5_000) // 5s old
    const liveAnchor = windowAnchor(false, null, now)
    expect(matchesFilters(stale, f, row({ nowAnchor: liveAnchor }))).toBe(false)
    expect(matchesFilters(recent, f, row({ nowAnchor: liveAnchor }))).toBe(true)
  })

  it('eventWireFamilies returns [] for unattributable events and the family otherwise', () => {
    const resolver: FeedResolver = {
      conn: (id) => (id === descriptor.id ? { ...descriptor, transport: 'websocket' } : undefined),
      nodeName: () => 'n',
    }
    expect(eventWireFamilies({ type: 'msg.publish', topic: 't', data: {} })).toEqual([])
    expect(
      eventWireFamilies(
        { type: 'msg.request', connId: descriptor.id, role: 'user', name: 'x', input: {}, reqId: 1 },
        resolver,
      ),
    ).toEqual(['websocket'])

    // broadcast (kind: 'many') → every family in the room's breakdown
    const broadcastResolver: FeedResolver = {
      conn: () => undefined,
      nodeName: () => 'n',
      roomWires: (r) => (r === 'lobby' ? [{ family: 'websocket', count: 2 }, { family: 'http', count: 1 }] : []),
    }
    expect(
      eventWireFamilies({ type: 'msg.broadcast', room: 'lobby', name: 'm', data: {} }, broadcastResolver),
    ).toEqual(['websocket', 'http'])
  })
})

describe('export', () => {
  const resolver: FeedResolver = {
    conn: (id) => (id === descriptor.id ? { ...descriptor, transport: 'websocket' } : undefined),
    nodeName: (id) => (id === 'node1234' ? 'node-1' : id.slice(0, 8)),
    roomWires: (r) => (r === 'lobby' ? [{ family: 'websocket', count: 2 }, { family: 'http', count: 1 }] : []),
  }
  const request: InspectorEvent = { type: 'msg.request', connId: descriptor.id, role: 'user', name: 'send', input: { a: 1 }, reqId: 1 }

  it('wireLabel renders one wire, a fan-out breakdown, or undefined', () => {
    expect(wireLabel(request, resolver)).toBe('WebSocket')
    expect(wireLabel({ type: 'msg.broadcast', room: 'lobby', name: 'm', data: {} }, resolver)).toBe('ws×2 http×1')
    expect(wireLabel({ type: 'msg.publish', topic: 't', data: {} }, resolver)).toBeUndefined()
  })

  it('exportRecord merges the envelope with the derived view columns', () => {
    const rec = exportRecord(envelope(request, 1000, 36), 'ada (user) → send', 28, resolver)
    expect(rec).toEqual({
      event: request,
      ts: 1000,
      byteSize: 36,
      originNodeId: 'node1234',
      summary: 'ada (user) → send',
      node: 'node-1',
      latencyMs: 28,
      wire: 'WebSocket',
    })
  })

  it('exportCsv emits a header, ISO times, empty cells and RFC-4180 quoting', () => {
    const tricky: InspectorEvent = { type: 'msg.publish', topic: 'a,"b"\nc', data: { s: 'x' } }
    const records = [
      exportRecord(envelope(request, 0, 36), 'ada (user) → send', 28, resolver),
      exportRecord(envelope(tricky, 1000), 'a,"b"\nc', undefined, resolver),
    ]
    const [header, row1, ...rest] = exportCsv(records).split('\n')
    expect(header).toBe('type,summary,node,time,size,latency,wire,payload')
    expect(row1).toBe('msg.request,ada (user) → send,node-1,1970-01-01T00:00:00.000Z,36,28,WebSocket,"{""a"":1}"')
    // the quoted newline in the summary keeps the record on "two lines" of the raw text
    expect(rest.join('\n')).toBe('msg.publish,"a,""b""\nc",node-1,1970-01-01T00:00:01.000Z,,,,"{""s"":""x""}"')
  })

  it('exportJsonl emits one parseable record per line', () => {
    const records = [
      exportRecord(envelope(request, 0), 's1', undefined, resolver),
      exportRecord(envelope(request, 1), 's2', 5, resolver),
    ]
    const lines = exportJsonl(records).split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toMatchObject({ summary: 's2', latencyMs: 5 })
  })

  it('exportJson wraps records with provenance: time, plain-JSON filters, node names', () => {
    const filters = emptyFilters()
    filters.types = new Set(['msg.request'])
    filters.latency = [1, 100]
    const records = [exportRecord(envelope(request, 0, 36), 'ada (user) → send', 28, resolver)]
    const out = JSON.parse(
      exportJson(records, {
        exportedAt: '2026-07-03T00:00:00.000Z',
        filters,
        nodes: [{ nodeId: 'node1234', nodeName: 'node-1' }],
      }),
    )
    expect(out.exportedAt).toBe('2026-07-03T00:00:00.000Z')
    expect(out.count).toBe(1)
    expect(out.filters).toEqual({
      text: '',
      types: ['msg.request'],
      nodes: [],
      wires: [],
      windowMs: null,
      latency: [1, 100],
      size: null,
    })
    expect(out.nodes).toEqual([{ nodeId: 'node1234', nodeName: 'node-1' }])
    expect(out.events).toHaveLength(1)
    expect(out.events[0].wire).toBe('WebSocket')
  })
})
