// Empirical protocol test for the headless shell (ticket 08), against a running dev server
// (pnpm dev:server on :8792). It:
//   (a) seeds a session file via the plain auth client (a throwaway user),
//   (b) runs `index.tsx` as a CHILD with piped stdio (auto-headless via !isTTY), sends a message on
//       stdin, and asserts <<READY>>, the `#agents you: …` echo, and <<TURN_START>>/<<TURN_DONE>>,
//   (c) re-runs with --json and asserts every stdout line is JSON of the curated types,
//   (d) drives a --control FIFO with two SEPARATE writes, proving the reopen-in-a-loop.
// Captures a transcript of the human + json runs to the ticket asset dir. Run:
//   bun --tsconfig-override src/tui/tsconfig.runtime.json src/tui/headless-smoke.ts

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { authClient } from '@super-line/plugin-auth/client'
import { app } from '../contract'
import { fileStorage } from './storage'

const URL = process.env.CHAT_SUPERVISOR_URL ?? 'ws://localhost:8792/super-line'
const HERE = (import.meta as unknown as { dir: string }).dir // src/tui (bun's import.meta.dir)
const EXAMPLE_DIR = resolve(HERE, '../../')
const ASSET = resolve(HERE, '../../../../.scratch/chat-supervisor-tui/assets/headless-transcript.txt')

const cacheDir = mkdtempSync(join(tmpdir(), 'chat-headless-smoke-'))
const cachePath = join(cacheDir, 'cache.json')

const fail = (msg: string, dump?: string): never => {
  console.error(`\nHEADLESS SMOKE FAIL: ${msg}`)
  if (dump) console.error(`---- captured stdout ----\n${dump}\n-------------------------`)
  process.exit(1)
}

// ── a child-process driver ────────────────────────────────────────────────────────────────────────
class Shell {
  readonly proc: ChildProcessWithoutNullStreams
  out = ''
  err = ''
  private waiters: { pred: (b: string) => boolean; res: () => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = []

  constructor(args: string[]) {
    // force the cache-file auth path: drop any ambient token override, point at our seeded cache
    const env: Record<string, string | undefined> = { ...process.env, CHAT_SUPERVISOR_CACHE: cachePath, CHAT_SUPERVISOR_URL: URL }
    delete env.CHAT_SUPERVISOR_TOKEN
    this.proc = spawn('bun', ['--tsconfig-override', 'src/tui/tsconfig.runtime.json', 'src/tui/index.tsx', ...args], {
      cwd: EXAMPLE_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stderr.setEncoding('utf8')
    this.proc.stdout.on('data', (c: string) => {
      this.out += c
      this.check()
    })
    this.proc.stderr.on('data', (c: string) => (this.err += c))
  }

  private check(): void {
    this.waiters = this.waiters.filter((w) => {
      if (!w.pred(this.out)) return true
      clearTimeout(w.timer)
      w.res()
      return false
    })
  }

  waitFor(pred: (b: string) => boolean, label: string, ms = 20000): Promise<void> {
    if (pred(this.out)) return Promise.resolve()
    return new Promise<void>((res, rej) => {
      const timer = setTimeout(() => fail(`timeout waiting for ${label}`, `${this.out}\n---- stderr ----\n${this.err}`), ms)
      this.waiters.push({ pred, res, rej, timer })
    })
  }

  send(line: string): void {
    this.proc.stdin.write(`${line}\n`)
  }

  kill(): void {
    this.proc.kill('SIGKILL')
  }
}

const has = (re: RegExp) => (b: string) => re.test(b)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fifoWrite(fifo: string, text: string): Promise<void> {
  // a fresh writer per call → the child's reader hits EOF and must reopen to receive the NEXT write
  await new Promise<void>((res, rej) => {
    const p = spawn('bash', ['-c', `printf '%s\\n' ${JSON.stringify(text)} > ${JSON.stringify(fifo)}`])
    p.on('exit', () => res())
    p.on('error', rej)
  })
}

// ── (a) seed a throwaway session into the cache file ────────────────────────────────────────────────
const email = `headless-smoke-${randomUUID()}@test.dev`
const displayName = `Headless ${randomUUID().slice(0, 6)}`
const auth = authClient<typeof app, 'user'>({
  authedRole: 'user',
  storage: fileStorage(cachePath),
  connect: ({ role, params }) =>
    createSuperLineClient(app, {
      transport: webSocketClientTransport({ url: URL }),
      role: role as 'user',
      params,
      crdtCollections: crdtCollectionsClient(),
    }),
})
await auth.ready
await auth.signUp({ email, password: 'password123', displayName })
if (auth.state.status !== 'authed') fail('seed signUp did not authenticate')
console.log(`(a) seeded session for ${displayName} (${auth.state.userId}) → ${cachePath}`)
;(auth.client as { close?: () => void }).close?.()

// ── (b) human mode: markers + `#agents you:` echo + a real supervisor turn ──────────────────────────
console.log('(b) human mode — spawning headless child (auto-headless via piped stdout)…')
const human = new Shell(['--channel', 'agents'])
await human.waitFor(has(/<<READY user=.* channel=agents>>/), '<<READY>>')
console.log('    got <<READY>>')
human.send('Reply with a short one-line greeting.')
await human.waitFor(has(/#agents you: Reply with a short one-line greeting\./), '`#agents you:` echo')
console.log('    got `#agents you:` echo (the `#channel user: text` line)')
await human.waitFor(has(/<<TURN_START channel=agents msg=/), '<<TURN_START>>', 40000)
console.log('    got <<TURN_START>>')
await human.waitFor(has(/<<TURN_DONE channel=agents msg=/), '<<TURN_DONE>>', 60000)
console.log('    got <<TURN_DONE>>')
if (!/#agents Supervisor: \S/.test(human.out)) fail('no supervisor message line rendered', human.out)
console.log('    got `#agents Supervisor:` reply line')
human.send('/quit')
await human.waitFor(has(/<<RESUME /), '<<RESUME>>')
console.log('    got <<RESUME>> on clean shutdown')
const humanTranscript = human.out
await sleep(300)
human.kill()

// ── (c) json mode: every stdout line is curated JSON ────────────────────────────────────────────────
console.log('(c) json mode — spawning with --json…')
const jsonShell = new Shell(['--channel', 'agents', '--json'])
await jsonShell.waitFor(has(/"kind":"ready"/), 'json status:ready')
console.log('    got status:ready')
jsonShell.send('Reply with a short one-line greeting.')
await jsonShell.waitFor(has(/"type":"message".*"role":"user"/), 'json user message echo')
console.log('    got message(role=user) echo')
await jsonShell.waitFor(has(/"kind":"turn_start"/), 'json status:turn_start', 40000)
await jsonShell.waitFor(has(/"kind":"turn_done"/), 'json status:turn_done', 60000)
console.log('    got status:turn_start and status:turn_done')

const jsonTranscript = jsonShell.out
// assert EVERY complete stdout line parses as JSON with a known curated type
const KNOWN = new Set(['status', 'message', 'delta', 'part', 'resource', 'presence', 'error', 'info'])
const lines = jsonTranscript.split('\n')
const complete = lines.slice(0, lines[lines.length - 1] === '' ? lines.length : -1).filter((l) => l.length > 0)
let sawDelta = false
let sawTurnStart = false
const parseLine = (l: string): { type?: string; kind?: string } => {
  try {
    return JSON.parse(l)
  } catch {
    return fail(`json mode emitted a non-JSON line: ${l}`, jsonTranscript)
  }
}
for (const l of complete) {
  const obj = parseLine(l)
  if (!obj.type || !KNOWN.has(obj.type)) fail(`json line has an unknown curated type: ${l}`, jsonTranscript)
  if (obj.type === 'delta' || obj.type === 'part') sawDelta = true
  if (obj.type === 'status' && obj.kind === 'turn_start') sawTurnStart = true
}
if (!sawTurnStart) fail('json mode never emitted a turn_start status', jsonTranscript)
if (!sawDelta) fail('json mode never emitted a delta/part (no streaming structure)', jsonTranscript)
if (!/"role":"assistant","content":"[^"]+"/.test(jsonTranscript)) fail('json assistant message had empty content', jsonTranscript)
console.log(`    all ${complete.length} stdout lines parsed as curated JSON (incl. delta/part + non-empty assistant message)`)
jsonShell.send('/quit')
await sleep(400)
jsonShell.kill()

// ── (d) control FIFO: two separate writes prove the reopen loop ──────────────────────────────────────
console.log('(d) control FIFO — two separate writes…')
const fifo = join(cacheDir, 'control.fifo')
const fifoShell = new Shell(['--channel', 'agents', '--control', fifo])
await fifoShell.waitFor(has(/<<READY /), 'fifo <<READY>>')
console.log('    got <<READY>> (control mode; no stdin pump)')
await fifoWrite(fifo, '/who')
await fifoShell.waitFor(has(/members of #agents:/), 'first FIFO write (/who) processed')
console.log('    first write (/who) landed')
await fifoWrite(fifo, '/channels')
await fifoShell.waitFor(has(/#agents \(/), 'second FIFO write (/channels) processed — reopen loop works')
console.log('    second write (/channels) landed → reopen-in-a-loop confirmed')
await fifoWrite(fifo, '/quit')
await fifoShell.waitFor(has(/<<RESUME /), 'fifo <<RESUME>>')
console.log('    got <<RESUME>> after /quit via FIFO')
const fifoTranscript = fifoShell.out
await sleep(300)
fifoShell.kill()

// ── capture the transcript ──────────────────────────────────────────────────────────────────────────
mkdirSync(resolve(ASSET, '..'), { recursive: true })
writeFileSync(
  ASSET,
  [
    `# headless-transcript.txt — captured ${new Date().toISOString()} by src/tui/headless-smoke.ts`,
    `# server: ${URL}   user: ${displayName}`,
    '',
    '========================================================================',
    '(b) HUMAN MODE   pnpm tui --headless --channel agents   (auto-headless when piped)',
    '     stdin: "Reply with a short one-line greeting." then /quit',
    '========================================================================',
    humanTranscript.trimEnd(),
    '',
    '========================================================================',
    '(c) JSON MODE    pnpm tui --headless --channel agents --json',
    '     stdin: "Reply with a short one-line greeting." then /quit',
    '========================================================================',
    jsonTranscript.trimEnd(),
    '',
    '========================================================================',
    '(d) CONTROL FIFO  pnpm tui --headless --channel agents --control <fifo>',
    '     two separate `printf > fifo` writes (/who, /channels) then /quit',
    '========================================================================',
    fifoTranscript.trimEnd(),
    '',
  ].join('\n'),
)
console.log(`\ncaptured transcript → ${ASSET}`)
console.log('\nHEADLESS SMOKE PASS')
process.exit(0)
