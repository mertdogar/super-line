import fs from 'node:fs'
import path from 'node:path'
import { loadAllRuns } from './load.js'
import { computeMetrics } from './metrics.js'
import { renderReport, toBaseline } from './report.js'

/**
 * Read every run's dumps, classify, and write the report.
 *
 * `--update-baseline` rewrites `baseline.json`. That is deliberately a separate, explicit act: the baseline
 * is the thing a future change is measured against, and a run that silently moved it would defeat the only
 * reason this fixture is permanent.
 */
const RUNS_DIR = process.env.RUNS_DIR ?? path.resolve(process.cwd(), 'runs')
const BASELINE = process.env.BASELINE_FILE ?? path.resolve(process.cwd(), 'baseline.json')
const REPORT = path.join(RUNS_DIR, 'report.md')
const update = process.argv.includes('--update-baseline')
const stamp = process.env.REPORT_STAMP ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z')

const runs = loadAllRuns(RUNS_DIR)
if (runs.length === 0) {
  console.error(`traffic-lab: no runs found under ${RUNS_DIR} — run the stack first`)
  process.exit(1)
}

const metrics = runs.map(computeMetrics)
const baseline = fs.existsSync(BASELINE) ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, number>) : undefined

fs.writeFileSync(REPORT, renderReport(metrics, baseline, stamp))
console.log(`[analyze] ${REPORT}`)
for (const m of metrics) {
  const ratio = m.totals.arrivals.count === 0 ? 1 : m.totals.accepted / m.totals.arrivals.count
  console.log(
    `[analyze] ${m.runId}: ${m.totals.publishes.count} publishes, ${m.totals.arrivals.count} arrivals, ` +
      `acceptance ${(ratio * 100).toFixed(1)}%`,
  )
}

if (update) {
  fs.writeFileSync(BASELINE, JSON.stringify(toBaseline(metrics), null, 2) + '\n')
  console.log(`[analyze] baseline updated: ${BASELINE}`)
} else if (baseline) {
  const current = toBaseline(metrics)
  const changed = Object.keys({ ...baseline, ...current }).filter((k) => baseline[k] !== current[k])
  console.log(
    changed.length === 0
      ? '[analyze] baseline: no change'
      : `[analyze] baseline: ${changed.length} metric(s) moved — see the report's diff section`,
  )
}
