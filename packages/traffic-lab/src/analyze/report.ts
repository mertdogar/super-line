import { PHASES } from '../phases.js'
import type { RunMetrics, Tally } from './metrics.js'
import { VERDICT_ORDER, type Verdict } from './verdict.js'

const kb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)
const pct = (n: number, of: number): string => (of === 0 ? '—' : `${((n / of) * 100).toFixed(1)}%`)
const t = (m: Map<string, Tally>, k: string): Tally => m.get(k) ?? { count: 0, bytes: 0 }

/** Flat metric-key → number, committed so a run that moves the numbers shows up as a reviewable diff. */
export function toBaseline(runs: RunMetrics[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of runs) {
    const p = (k: string, v: number): void => {
      out[`${r.runId}/${k}`] = v
    }
    p('total.publishes', r.totals.publishes.count)
    p('total.delivers', r.totals.delivers.count)
    p('total.arrivals', r.totals.arrivals.count)
    p('total.accepted', r.totals.accepted)
    p('total.arrivalBytes', r.totals.arrivals.bytes)
    for (const v of VERDICT_ORDER) p(`arrivals.${v}`, t(r.arrivalVerdicts as Map<string, Tally>, v).count)
    for (const v of VERDICT_ORDER) p(`publishes.${v}`, t(r.publishVerdicts as Map<string, Tally>, v).count)
    for (const ph of r.phases) {
      if (ph.publishes === 0 && ph.arrivals === 0) continue
      p(`phase.${ph.n}.${ph.name}.publishes`, ph.publishes)
      p(`phase.${ph.n}.${ph.name}.discarded`, ph.discarded)
      p(`phase.${ph.n}.${ph.name}.wastedPublishes`, ph.wastedPublishes)
    }
    p('client.framesIn', r.client.framesIn)
    p('client.framesOut', r.client.framesOut)
    p('client.leftFilter', r.client.leftFilter)
    p('client.zeroListener', r.client.zeroListener)
  }
  return out
}

export function renderReport(runs: RunMetrics[], baseline: Record<string, number> | undefined, now: string): string {
  const lines: string[] = []
  const w = (s = ''): void => void lines.push(s)

  w('# super-line traffic report')
  w()
  w(`Generated ${now} · ${runs.length} run${runs.length === 1 ? '' : 's'}`)
  w()
  w('Every number below is measured, not modelled. Verdicts follow the delivery verdict in `CONTEXT.md`:')
  w('**useful** (a local subscriber wanted it) · **by-design** (a real cost with a named reason) ·')
  w('**observation** (exists only because something is watching) · **waste** (removable with no observable change).')
  w()

  w('## Headline')
  w()
  w('| run | adapter | inspector | publishes | delivers | mesh arrivals | accepted | acceptance ratio | waste |')
  w('|---|---|---|---:|---:|---:|---:|---:|---:|')
  for (const r of runs) {
    const waste = t(r.arrivalVerdicts as Map<string, Tally>, 'waste').count
    const ratio = r.totals.arrivals.count === 0 ? 1 : r.totals.accepted / r.totals.arrivals.count
    w(
      `| \`${r.runId}\` | ${r.adapter} | ${r.inspector ? 'on' : 'off'} | ${r.totals.publishes.count} | ` +
        `${r.totals.delivers.count} | ${r.totals.arrivals.count || '—'} | ${r.totals.accepted} | ` +
        `${r.totals.arrivals.count === 0 ? '—' : `${(ratio * 100).toFixed(1)}%`} | ` +
        `${waste} (${pct(waste, r.totals.arrivals.count)}) |`,
    )
  }
  w()
  w(
    '> The Redis profile has no mesh layer to listen to — it filters at the broker, so its acceptance ratio is 1.0',
  )
  w('> by construction. Its role is the bytes-and-publish-count reference, not a ratio to compare.')
  w()

  for (const r of runs) {
    w(`## ${r.runId}`)
    w()
    w(`adapter **${r.adapter}** · inspector **${r.inspector ? 'on' : 'off'}**`)
    w()

    w('### Per phase')
    w()
    w('| # | phase | ops | publishes | delivers | arrivals | accepted | discarded | wasted pub | what it isolates |')
    w('|---:|---|---:|---:|---:|---:|---:|---:|---:|---|')
    for (const ph of r.phases) {
      const spec = PHASES.find((p) => p.n === ph.n)
      w(
        `| ${ph.n} | ${ph.name} | ${ph.ops} | ${ph.publishes} | ${ph.delivers} | ${ph.arrivals} | ${ph.accepted} | ` +
          `**${ph.discarded}** | **${ph.wastedPublishes}** | ${spec?.detail ?? ''} |`,
      )
    }
    w()

    w('### Verdicts')
    w()
    w('| verdict | arrivals | bytes | publishes | bytes |')
    w('|---|---:|---:|---:|---:|')
    for (const v of VERDICT_ORDER) {
      const a = t(r.arrivalVerdicts as Map<string, Tally>, v)
      const p = t(r.publishVerdicts as Map<string, Tally>, v)
      w(`| ${v} | ${a.count} (${pct(a.count, r.totals.arrivals.count)}) | ${kb(a.bytes)} | ${p.count} | ${kb(p.bytes)} |`)
    }
    w()
    const kinds = [...r.arrivalKinds.entries()].sort((a, b) => b[1].count - a[1].count)
    if (kinds.length > 0) {
      w('Breakdown by mechanism:')
      w()
      w('| mechanism | arrivals | bytes |')
      w('|---|---:|---:|')
      for (const [k, v] of kinds) w(`| \`${k}\` | ${v.count} | ${kb(v.bytes)} |`)
      w()
    }
    const pubKinds = [...r.publishKinds.entries()].filter(([k]) => k.startsWith('waste:'))
    if (pubKinds.length > 0) {
      w('Publisher-side waste — the same events seen from the end that could have avoided them:')
      w()
      w('| mechanism | publishes | bytes |')
      w('|---|---:|---:|')
      for (const [k, v] of pubKinds.sort((a, b) => b[1].count - a[1].count)) w(`| \`${k}\` | ${v.count} | ${kb(v.bytes)} |`)
      w()
    }

    w('### Per node')
    w()
    w('| node | arrivals | accepted | acceptance ratio | attributed | NIC rx | NIC tx | overhead |')
    w('|---|---:|---:|---:|---:|---:|---:|---:|')
    for (const n of r.nodes) {
      const nicKnown = n.nicRx >= 0 && n.nicTx >= 0
      const overhead = nicKnown && n.attributedBytes > 0 ? `${((n.nicRx + n.nicTx) / n.attributedBytes).toFixed(1)}×` : '—'
      w(
        `| ${n.node} | ${n.arrivals} | ${n.accepted} | **${(n.acceptanceRatio * 100).toFixed(1)}%** | ` +
          `${kb(n.attributedBytes)} | ${nicKnown ? kb(n.nicRx) : '—'} | ${nicKnown ? kb(n.nicTx) : '—'} | ${overhead} |`,
      )
    }
    w()
    w('> Overhead is total interface bytes ÷ bytes super-line can account for: Noise encryption, yamux and TCP')
    w("> framing, and above all gossipsub's own control traffic, none of which any in-process tap can see.")
    w()

    w('### Channels')
    w()
    w('| channel class | arrivals | accepted | discarded | bytes |')
    w('|---|---:|---:|---:|---:|')
    for (const c of r.channels)
      w(
        `| \`${c.channel}\` | ${c.arrivals.count} | ${c.accepted} | ${c.arrivals.count - c.accepted} | ${kb(c.arrivals.bytes)} |`,
      )
    w()

    w('### Client side')
    w()
    w('| frames in | bytes in | frames out | bytes out | re-filtered away | 0-listener | 0-replica |')
    w('|---:|---:|---:|---:|---:|---:|---:|')
    w(
      `| ${r.client.framesIn} | ${kb(r.client.bytesIn)} | ${r.client.framesOut} | ${kb(r.client.bytesOut)} | ` +
        `${r.client.leftFilter} | ${r.client.zeroListener} | ${r.client.zeroReplica} |`,
    )
    w()
    w('> `re-filtered away` is a row change the server delivered and the subscription then dropped. That is')
    w('> permissive routing working as designed — it keeps fan-out stateless per connection — and it is')
    w('> counted here so the cost of that choice is visible rather than assumed.')
    w()
  }

  if (baseline) {
    w('## Baseline diff')
    w()
    const current = toBaseline(runs)
    const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()
    const changed = keys.filter((k) => baseline[k] !== current[k])
    if (changed.length === 0) {
      w('No change against the committed baseline.')
    } else {
      w('| metric | baseline | now | Δ |')
      w('|---|---:|---:|---:|')
      for (const k of changed) {
        const before = baseline[k]
        const after = current[k]
        const delta = before === undefined || after === undefined ? '—' : `${after - before > 0 ? '+' : ''}${after - before}`
        w(`| \`${k}\` | ${before ?? '—'} | ${after ?? '—'} | ${delta} |`)
      }
    }
    w()
  }

  return lines.join('\n')
}

export type { Verdict }
