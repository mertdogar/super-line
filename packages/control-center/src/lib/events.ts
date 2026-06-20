import type { InspectorEvent, MessageFlavor } from '@super-line/core'

/** A short human summary of a live inspector event, for the feed. */
export function summarizeEvent(event: InspectorEvent): string {
  switch (event.type) {
    case 'connect':
      return `${event.descriptor.role} ${event.descriptor.id.slice(0, 8)} on ${event.descriptor.nodeId.slice(0, 8)}`
    case 'disconnect':
      return `${event.connId.slice(0, 8)} on ${event.nodeId.slice(0, 8)}`
    case 'room.add':
    case 'room.remove':
      return `${event.connId.slice(0, 8)} · ${event.room}`
    case 'topic.sub':
    case 'topic.unsub':
      return `${event.connId.slice(0, 8)} · ${event.topic}`
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
  serverEvent: '#fb923c',
}

export function flavorColor(flavor: MessageFlavor): string {
  return FLAVOR_COLORS[flavor]
}
