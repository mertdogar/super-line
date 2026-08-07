// SCRATCH — crash-resume demo: `node scratch/demo.mjs` (build the package first).
// Seeds a job + a multi-step workflow, SIGKILLs the process mid-timer,
// restarts, and shows the workflow resume from its checkpoint.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DB = process.env.DEMO_DB ?? '/tmp/sl-plugin-workflows-demo.db'
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url))

const run = (role) => spawn(process.execPath, [worker, role], { stdio: 'inherit', env: { ...process.env, DEMO_DB: DB } })

rmSync(DB, { force: true })

console.log('════ PHASE 1: seed (job + workflow), then SIGKILL mid-timer ════')
const seed = run('seed')
await new Promise((r) => setTimeout(r, 3_500))
seed.kill('SIGKILL')
console.log('\n════ CRASH (SIGKILL — no graceful shutdown) ════\n')
await new Promise((r) => setTimeout(r, 500))

console.log('════ PHASE 2: restart and resume ════')
const resume = run('resume')
await new Promise((r) => resume.on('exit', r))
console.log('\n════ demo done ════')
