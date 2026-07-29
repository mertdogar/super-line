import fs from 'node:fs'
import type { Recorder } from './record.js'

/**
 * Total bytes on the container's interface.
 *
 * Every other layer counts payloads super-line knows about. This counts what the kernel actually moved,
 * so the report can quote an overhead factor — Noise encryption, yamux framing, TCP, and above all
 * gossipsub's own control traffic (IHAVE/IWANT/GRAFT/PRUNE), none of which any in-process tap can see.
 * Read from sysfs rather than a pcap sidecar: no privileges, no extra container.
 */
const IFACE = process.env.LAB_IFACE ?? 'eth0'

const read = (name: string): number => {
  try {
    return Number(fs.readFileSync(`/sys/class/net/${IFACE}/statistics/${name}`, 'utf8').trim())
  } catch {
    return -1 // not Linux, or no such interface — the analyzer reports the overhead factor as unavailable
  }
}

export function sampleNic(rec: Recorder): void {
  rec.write({ layer: 'nic', rx: read('rx_bytes'), tx: read('tx_bytes') })
}

export const nicAvailable = (): boolean => read('rx_bytes') >= 0
