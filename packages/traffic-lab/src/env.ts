/** Environment every lab actor reads. Compose is the only writer; nothing here has a runtime default that hides a misconfiguration. */

export const str = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback
  if (v === undefined) throw new Error(`traffic-lab: missing required env ${name}`)
  return v
}

export const num = (name: string, fallback?: number): number => {
  const raw = process.env[name]
  if (raw === undefined) {
    if (fallback === undefined) throw new Error(`traffic-lab: missing required env ${name}`)
    return fallback
  }
  const v = Number(raw)
  if (!Number.isFinite(v)) throw new Error(`traffic-lab: env ${name} is not a number: ${raw}`)
  return v
}

export const flag = (name: string, fallback = false): boolean => {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  return raw === '1' || raw.toLowerCase() === 'on' || raw.toLowerCase() === 'true'
}

/** Which cross-node fan-out substrate this run uses. The Redis profile is the control (see PLAN decision 8). */
export type AdapterKind = 'libp2p' | 'redis'

export const adapterKind = (): AdapterKind => {
  const v = str('ADAPTER', 'libp2p')
  if (v !== 'libp2p' && v !== 'redis') throw new Error(`traffic-lab: ADAPTER must be libp2p|redis, got ${v}`)
  return v
}

/** Label for one run's dumps + report row: `<adapter>-inspector-<on|off>`. */
export const runId = (): string => str('RUN_ID', `${adapterKind()}-inspector-${flag('SL_INSPECTOR') ? 'on' : 'off'}`)
