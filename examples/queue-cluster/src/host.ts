import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const pgUrl = process.env.PG_URL ?? 'postgres://queue:queue@127.0.0.1:55432/queue'
const children: ChildProcess[] = []
let stopping = false

for (const [index, name] of ['node-1', 'node-2'].entries()) {
  const child = spawn('pnpm', ['exec', 'tsx', 'src/node.ts'], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      PG_URL: pgUrl,
      NODE_NAME: name,
      NODE_KEY: name,
      PORT: String(8801 + index),
      BOOTSTRAP: index === 0 ? 'true' : 'false',
    },
  })
  children.push(child)
  child.once('exit', (code, signal) => {
    if (stopping) return
    console.error(`${name} exited unexpectedly (${signal ?? code ?? 'unknown'})`)
    void stop(1)
  })
}

console.log(`started node-1 on :8801 and node-2 on :8802 using ${pgUrl}`)

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve()
          else child.once('exit', () => resolve())
        }),
    ),
  )
  process.exitCode = exitCode
}

process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
