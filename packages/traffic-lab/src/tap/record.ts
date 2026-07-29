import fs from 'node:fs'
import path from 'node:path'
import type { InspectorEvent } from '@super-line/core'
import type { ClientTapEvent } from '@super-line/core'

/**
 * One observation, from one layer, on one actor. Records are buffered in memory and flushed at phase
 * boundaries: a tap that did file I/O inline would add its own latency to the thing it is measuring.
 */
/** The envelope every record carries, filled by the {@link Recorder} rather than by the call site. */
export interface LabEnvelope {
  t: number
  actor: string
  phase: number | null
  op: number | null
}

export type LabPayload =
  | { layer: 'meta'; node?: string; peerId?: string; adapter: string; inspector: boolean }
  /** What the app asked for — the denominator every other layer is measured against. */
  | { layer: 'l1'; event: InspectorEvent }
  /** The Adapter seam: cross-node intent, and what this node locally accepted. */
  | { layer: 'l2'; kind: 'publish' | 'deliver' | 'subscribe' | 'unsubscribe'; channel: string; bytes: number }
  /** The gossipsub mesh: every frame that ARRIVED, including the ones the adapter discards. */
  | { layer: 'l3'; channel: string; bytes: number; from: string; msgId: string; accepted: boolean }
  /** The client wire, plus the client-local decisions no server can be asked about. */
  | { layer: 'l5'; event: ClientTapEvent }
  /** Total bytes on the interface — the ground truth attributed bytes are compared against. */
  | { layer: 'nic'; rx: number; tx: number }

export type LabRecord = LabEnvelope & LabPayload

export type LabInput = LabPayload & { phase?: number | null; op?: number | null }

export class Recorder {
  private buffer: LabRecord[] = []
  private phase: number | null = null
  private readonly file: string
  private written = 0

  constructor(
    private readonly actor: string,
    dir: string,
    runId: string,
  ) {
    const runDir = path.join(dir, runId)
    fs.mkdirSync(runDir, { recursive: true })
    this.file = path.join(runDir, `${actor}.ndjson`)
    fs.writeFileSync(this.file, '') // a run always starts from an empty dump, never appends to a stale one
  }

  setPhase(phase: number | null): void {
    this.phase = phase
  }

  write(input: LabInput): void {
    const { phase, op, ...payload } = input
    this.buffer.push({
      ...(payload as LabPayload),
      t: Date.now(),
      actor: this.actor,
      phase: phase !== undefined ? phase : this.phase,
      op: op ?? null,
    })
  }

  flush(): { written: number; buffered: number } {
    const batch = this.buffer
    this.buffer = []
    if (batch.length > 0) fs.appendFileSync(this.file, batch.map((r) => JSON.stringify(r)).join('\n') + '\n')
    this.written += batch.length
    return { written: this.written, buffered: batch.length }
  }
}

/**
 * Pull the workload op id out of a decoded cross-node frame. Every shape the lab's own contract can
 * produce is covered; anything else (presence, heartbeats, CRDT deltas, inspector envelopes) has no op
 * id by nature and is attributed by channel instead.
 */
export function extractOp(decoded: unknown): number | null {
  if (decoded === null || typeof decoded !== 'object') return null
  const f = decoded as Record<string, unknown>
  const direct = (f.d as Record<string, unknown> | undefined)?.op // evt / pub frames
  if (typeof direct === 'number') return direct
  const personal = ((f.f as Record<string, unknown> | undefined)?.d as Record<string, unknown> | undefined)?.op
  if (typeof personal === 'number') return personal
  const inner = (f.event as Record<string, unknown> | undefined) // an inspector envelope wrapping a tap event
  if (inner) {
    const nested = (inner.data ?? inner.input ?? inner.output) as Record<string, unknown> | undefined
    if (nested && typeof nested.op === 'number') return nested.op
  }
  const ops = f.ops as Array<Record<string, unknown>> | undefined // a collection relay batch
  const row = ops?.[0]?.row as Record<string, unknown> | undefined
  if (row && typeof row.op === 'number') return row.op
  return null
}

export const byteLength = (payload: string | Uint8Array): number =>
  typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
