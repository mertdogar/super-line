#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Drive the full matrix: {libp2p, redis} × {inspector off, on}.
 *
 * The adapter axis exists because "19.5% of arrivals discarded" means nothing without a broker-filtered
 * reference on the identical workload. The inspector axis exists because the inspector republishes every
 * event it observes cluster-wide, and the cost of that is expected to depend on the adapter underneath:
 * on Redis an unwanted publish reaches a channel with no subscribers and is nearly free, while on libp2p
 * the same call is a full mesh broadcast to every node.
 *
 *   node run.mjs                      # all four profiles, then the report
 *   node run.mjs --only libp2p        # one adapter
 *   node run.mjs --update-baseline    # rewrite baseline.json from this matrix
 *   node run.mjs --skip-run           # re-analyze the dumps already on disk
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}

const only = value('--only')
const PROFILES = [
  { adapter: 'libp2p', inspector: 'off' },
  { adapter: 'libp2p', inspector: 'on' },
  { adapter: 'redis', inspector: 'off' },
  { adapter: 'redis', inspector: 'on' },
].filter((p) => !only || p.adapter === only)

const run = (cmd, cmdArgs, env) => {
  const res = spawnSync(cmd, cmdArgs, { cwd: here, stdio: 'inherit', env: { ...process.env, ...env } })
  if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(' ')} exited ${res.status}`)
}
const quiet = (cmd, cmdArgs, env) =>
  spawnSync(cmd, cmdArgs, { cwd: here, stdio: 'ignore', env: { ...process.env, ...env } })

if (!flag('--skip-run')) {
  for (const { adapter, inspector } of PROFILES) {
    const runId = `${adapter}-inspector-${inspector}`
    const env = {
      ADAPTER: adapter,
      SL_INSPECTOR: inspector,
      RUN_ID: runId,
      // A profiled service is only created when its profile is active, so the Redis container exists
      // exactly for the Redis runs and never idles alongside the libp2p ones.
      ...(adapter === 'redis' ? { COMPOSE_PROFILES: 'redis' } : {}),
    }
    console.log(`\n===== ${runId} =====\n`)
    rmSync(path.join(here, 'runs', runId), { recursive: true, force: true })
    quiet('docker', ['compose', 'down', '-v'], env)
    run('docker', ['compose', 'up', '--abort-on-container-exit', '--exit-code-from', 'conductor'], env)
    quiet('docker', ['compose', 'down', '-v'], env)
  }
}

console.log('\n===== analyze =====\n')
run('npx', ['tsx', 'src/analyze/index.ts', ...(flag('--update-baseline') ? ['--update-baseline'] : [])])
