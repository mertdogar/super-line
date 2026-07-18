// Captures a styled (colored) frame of the live cockpit for the README/docs screenshot: registers a
// throwaway user, has the Supervisor genuinely delegate sticky notes onto the channel canvas, then
// dumps captureSpans() JSON for spans-to-html rendering. Needs a running server (pnpm dev:server)
// with an AI key. Run: bun --tsconfig-override src/tui/tsconfig.runtime.json src/tui/screenshot.tsx

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const cacheDir = mkdtempSync(join(tmpdir(), 'chat-tui-shot-'))
process.env.CHAT_SUPERVISOR_CACHE = join(cacheDir, 'cache.json')
process.env.CHAT_SUPERVISOR_URL ??= 'ws://localhost:8792/super-line'

const { createTestRenderer } = await import('@opentui/core/testing')
const { createRoot } = await import('@opentui/react')
const { chatClient } = await import('@super-line/plugin-chat/client')
const { auth, AuthProvider } = await import('./auth')
const { App } = await import('./app')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

await auth.ready
await auth.signUp({ email: `shot-${randomUUID()}@test.dev`, password: 'password123', displayName: 'Mert' })
const me = auth.state.userId
if (!me) throw new Error('signUp failed')

// Use the seeded #agents channel — it's channels[0], where the cockpit lands, and the
// Supervisor is guaranteed to be a member.
const chat = chatClient(auth.client, { userId: me })
await chat.ready
const dir = chat.channels()
let agents: { id: string } | undefined
for (let i = 0; i < 50 && !agents; i++) {
  agents = (dir.rows() as { id: string; name: string }[]).find((c) => c.name === 'agents')
  if (!agents) await sleep(200)
}
if (!agents) throw new Error('no #agents channel')
const channel = agents
await chat.join(channel.id).catch(() => {})

const t = await createTestRenderer({ width: 150, height: 44 })
createRoot(t.renderer).render(
  <AuthProvider>
    <App quit={() => {}} />
  </AuthProvider>,
)

const frame = async (): Promise<string> => {
  await t.renderOnce()
  return t.captureCharFrame()
}

// Let the cockpit land on #agents, then drive a real Supervisor turn.
let ok = false
for (let i = 0; i < 100 && !ok; i++) {
  ok = (await frame()).includes('# agents')
  if (!ok) await sleep(200)
}
if (!ok) {
  console.error(await frame())
  throw new Error('cockpit never joined #agents')
}
await chat.send(channel.id, 'Plan the launch — put sticky notes for the key tasks on the canvas.')
let seen = false
for (let i = 0; i < 90 && !seen; i++) {
  seen = (await frame()).includes('editor')
  if (!seen) await sleep(1000)
}
if (!seen) throw new Error('no delegation appeared')
// Wait for the turn to settle and the delegated notes to land in the pane.
let last = ''
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  const f = await frame()
  if (f === last && !f.includes('streaming')) break
  last = f
}

const spans = t.captureSpans()
const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
writeFileSync(join(exampleRoot, 'tui-frame-spans.json'), JSON.stringify(spans))
writeFileSync(join(exampleRoot, 'tui-frame.txt'), await frame())
console.log('captured → tui-frame-spans.json / tui-frame.txt')
t.renderer.destroy()
process.exit(0)
