import type { ConnDescriptor, InspectorEvent, MessageFlavor } from '@super-line/core'

/** Resolves a connId / nodeId to friendly labels, so the feed shows names not hashes. */
export interface FeedResolver {
  conn(connId: string): ConnDescriptor | undefined
  nodeName(nodeId: string): string
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
  }
}

/** Tailwind text/bg accent class for an event type (feed dot). */
export function eventColor(type: InspectorEvent['type']): string {
  if (type === 'connect') return 'bg-primary'
  if (type === 'disconnect') return 'bg-destructive'
  if (type.startsWith('room')) return 'bg-violet-400'
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
