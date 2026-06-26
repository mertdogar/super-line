import type { ConnDescriptor, InspectorEnvelope, InspectorEvent, MessageFlavor } from '@super-line/core'
import { familyColor, familyShort, transportColor, transportLabel, type TransportFamily } from './transport'

export { eventPayload } from '@super-line/core'

/** Resolves a connId / nodeId to friendly labels, so the feed shows names not hashes. */
export interface FeedResolver {
  conn(connId: string): ConnDescriptor | undefined
  nodeName(nodeId: string): string
  /** Wire-family breakdown of the connections currently in `room` (for broadcast attribution). */
  roomWires?(room: string): { family: TransportFamily; count: number }[]
}

/** The wire(s) a feed row is attributable to: one wire (inbound rows) or a fan-out breakdown (broadcasts). */
export type WireAttribution =
  | { kind: 'one'; label: string; color: string }
  | { kind: 'many'; parts: { short: string; count: number; color: string }[] }

function wireOf(transport: string | undefined): WireAttribution {
  return { kind: 'one', label: transportLabel(transport), color: transportColor(transport) }
}

function connWire(connId: string, r?: FeedResolver): WireAttribution | undefined {
  const d = r?.conn(connId)
  return d ? wireOf(d.transport) : undefined // no chip when the conn is unknown/already purged
}

/**
 * The wire a feed row is attributable to, or `undefined` when it isn't. Inbound rows
 * (request/response, lifecycle, directed event) resolve to one wire via their connId; a broadcast
 * resolves to its room members' wires. `msg.publish` (topic subs aren't in the descriptor) and
 * `msg.serverRequest`/`serverReply` (the node↔node adapter axis, not a client wire) are intentionally
 * left unattributed.
 */
export function eventWire(event: InspectorEvent, r?: FeedResolver): WireAttribution | undefined {
  switch (event.type) {
    case 'connect':
      return wireOf(event.descriptor.transport)
    case 'disconnect':
    case 'room.add':
    case 'room.remove':
    case 'topic.sub':
    case 'topic.unsub':
    case 'msg.request':
    case 'msg.response':
      return connWire(event.connId, r)
    case 'msg.event':
      return connWire(event.target, r)
    case 'msg.broadcast': {
      const wires = r?.roomWires?.(event.room) ?? []
      return wires.length
        ? {
            kind: 'many',
            parts: wires.map((w) => ({ short: familyShort(w.family), count: w.count, color: familyColor(w.family) })),
          }
        : undefined
    }
    case 'msg.publish':
    case 'msg.serverRequest':
    case 'msg.serverReply':
      return undefined
    case 'store.subscribe':
    case 'store.unsubscribe':
      return connWire(event.connId, r)
    case 'store.write':
      return event.connId ? connWire(event.connId, r) : undefined
    case 'store.create':
    case 'store.delete':
    case 'store.grant':
    case 'store.revoke':
      return undefined
  }
}

function nameOf(role: string, id: string, userId?: string): string {
  return userId ? `${userId} (${role})` : `${role} ${id.slice(0, 8)}`
}

function who(connId: string, r?: FeedResolver): string {
  const d = r?.conn(connId)
  return d ? nameOf(d.role, d.id, d.userId) : connId.slice(0, 8)
}

/** A short human summary of a live inspector event, for the feed. Pass a resolver to show names. */
export function summarizeEvent(event: InspectorEvent, r?: FeedResolver): string {
  switch (event.type) {
    case 'connect': {
      const d = event.descriptor
      return `${nameOf(d.role, d.id, d.userId)} on ${d.nodeName}`
    }
    case 'disconnect': {
      const label = event.userId ?? who(event.connId, r)
      return `${label} on ${r?.nodeName(event.nodeId) ?? event.nodeId.slice(0, 8)}`
    }
    case 'room.add':
    case 'room.remove':
      return `${who(event.connId, r)} · ${event.room}`
    case 'topic.sub':
    case 'topic.unsub':
      return `${who(event.connId, r)} · ${event.topic}`
    case 'msg.request':
      return `${who(event.connId, r)} → ${event.name}`
    case 'msg.response':
      return `${who(event.connId, r)} ← ${event.name} · ${event.ok ? 'ok' : event.error?.code ?? 'error'}`
    case 'msg.event':
      return `→ ${who(event.target, r)} · ${event.name}`
    case 'msg.broadcast':
      return `${event.room} ⇒ ${event.name}`
    case 'msg.publish':
      return event.topic
    case 'msg.serverRequest':
      return `→ ${who(event.target, r)} · ${event.name}`
    case 'msg.serverReply':
      return `← ${who(event.target, r)} · ${event.name} · ${event.ok ? 'ok' : event.error?.code ?? 'error'}`
    case 'store.create':
      return `+ ${event.store}/${event.id}`
    case 'store.delete':
      return `− ${event.store}/${event.id}`
    case 'store.write':
      return `${event.store}/${event.id}`
    case 'store.grant':
      return `${event.store}/${event.id} +${event.principal}`
    case 'store.revoke':
      return `${event.store}/${event.id} −${event.principal}`
    case 'store.subscribe':
    case 'store.unsubscribe':
      return `${who(event.connId, r)} · ${event.store}/${event.id}`
  }
}

/** Coarse feed category, for the live-feed filter toggles. */
export type FeedCategory = 'lifecycle' | 'requests' | 'events' | 'stores'

export function eventCategory(type: InspectorEvent['type']): FeedCategory {
  if (type === 'msg.request' || type === 'msg.response' || type === 'msg.serverRequest' || type === 'msg.serverReply')
    return 'requests'
  if (type.startsWith('store.')) return 'stores'
  if (type.startsWith('msg.')) return 'events'
  return 'lifecycle'
}

/** Tailwind text/bg accent class for an event type (feed dot). */
export function eventColor(type: InspectorEvent['type']): string {
  if (type === 'connect') return 'bg-primary'
  if (type === 'disconnect') return 'bg-destructive'
  if (type.startsWith('room')) return 'bg-violet-400'
  if (type.startsWith('topic')) return 'bg-amber-400'
  if (type.startsWith('store')) return 'bg-orange-400'
  if (type === 'msg.request' || type === 'msg.serverRequest') return 'bg-cyan-400'
  if (type === 'msg.response' || type === 'msg.serverReply') return 'bg-emerald-400'
  if (type === 'msg.event' || type === 'msg.broadcast' || type === 'msg.publish') return 'bg-sky-400'
  return 'bg-amber-400'
}

const FLAVOR_COLORS: Record<MessageFlavor, string> = {
  request: '#22d3ee',
  event: '#34d399',
  topic: '#a78bfa',
  serverRequest: '#60a5fa',
}

export function flavorColor(flavor: MessageFlavor): string {
  return FLAVOR_COLORS[flavor]
}

/** Clock time of an epoch-ms instant, e.g. "9:58:42 PM". */
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString()
}

/** Compact elapsed time since an epoch-ms instant, e.g. "14m", "2h 3m". */
export function formatDuration(ms: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/** Human byte size, e.g. "512 B", "1.2 KB". Em-dash for events with no payload. */
export function formatBytes(n?: number): string {
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Correlation key pairing a response/reply with its request, or undefined for unpaired events. */
function pairKey(event: InspectorEvent): string | undefined {
  switch (event.type) {
    case 'msg.request':
    case 'msg.response':
      return `c:${event.connId}:${event.reqId}`
    case 'msg.serverRequest':
    case 'msg.serverReply':
      return `s:${event.target}:${event.reqId}`
    default:
      return undefined
  }
}

/** Emit times of the request/serverRequest envelopes in `envs`, keyed for pairing. */
export function requestTimes(envs: InspectorEnvelope[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const en of envs) {
    if (en.event.type === 'msg.request' || en.event.type === 'msg.serverRequest') {
      const k = pairKey(en.event)
      if (k) m.set(k, en.ts)
    }
  }
  return m
}

/** Round-trip ms for a response/reply envelope, or undefined if its request isn't in `reqTimes`. */
export function latencyOf(en: InspectorEnvelope, reqTimes: Map<string, number>): number | undefined {
  if (en.event.type !== 'msg.response' && en.event.type !== 'msg.serverReply') return undefined
  const k = pairKey(en.event)
  const t0 = k === undefined ? undefined : reqTimes.get(k)
  return t0 === undefined ? undefined : Math.max(0, en.ts - t0)
}
