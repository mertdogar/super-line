import { safeSnapshot, type InspectorEvent } from '@super-line/core'
import type { SuperLinePlugin } from '@super-line/server'
import type { SuperLineClientPlugin } from '@super-line/client'
import { extractOp, type Recorder } from './record.js'

/**
 * L1 — what the app asked for. The denominator: one `msg.broadcast` here is the single logical operation
 * that every cross-node frame and every client delivery downstream of it has to be justified against.
 *
 * Taps fire synchronously with LIVE payload references, so anything kept must be snapshotted at the emit
 * site rather than at flush time — a payload mutated afterwards would rewrite history.
 */
export function serverTapPlugin(rec: Recorder): SuperLinePlugin {
  return {
    name: 'traffic-lab-tap',
    onEvent(event) {
      const snapped = safeSnapshot(event) as InspectorEvent
      rec.write({ layer: 'l1', event: snapped, op: opOfEvent(snapped) })
    },
  }
}

function opOfEvent(event: InspectorEvent): number | null {
  const e = event as unknown as Record<string, unknown>
  for (const key of ['data', 'input', 'output', 'row']) {
    const payload = e[key] as Record<string, unknown> | undefined
    if (payload && typeof payload.op === 'number') return payload.op
  }
  const ops = e.ops as Array<Record<string, unknown>> | undefined
  const first = ops?.[0]?.d as Record<string, unknown> | undefined
  if (first && typeof first.op === 'number') return first.op
  return null
}

/**
 * L5 — the client wire plus the decisions that never reach it (ADR-0024): a row change a subscription
 * re-filtered away, an event that found no listener, a delta for a document nobody has open. Those are
 * server→client waste that no server-side observer can reconstruct at any price.
 */
export function clientTapPlugin(rec: Recorder): SuperLineClientPlugin {
  return {
    name: 'traffic-lab-tap',
    onClientSideEvent(event) {
      const snapped = safeSnapshot(event) as typeof event
      rec.write({ layer: 'l5', event: snapped, op: snapped.k === 'frame' ? extractOp(snapped.f) : null })
    },
  }
}
