// Empirical smoke test against a running chat-supervisor server (pnpm dev:server). Proves the full
// hook → OpenTUI reconciler → frame path: register a throwaway user, create a channel, send a
// message, and poll captured frames until the real transcript renders it. Also asserts the session
// token is cached to a file and a second boot restores it without a login, and captures one full
// cockpit frame. Run: bun src/tui/smoke.tsx

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { CanvasDoc, FeedMessage } from '../contract'

// Point the session cache at an isolated temp file BEFORE importing config-backed modules.
const cacheDir = mkdtempSync(join(tmpdir(), 'chat-tui-smoke-'))
const cachePath = join(cacheDir, 'cache.json')
process.env.CHAT_SUPERVISOR_CACHE = cachePath
process.env.CHAT_SUPERVISOR_URL ??= 'ws://localhost:8792/super-line'

const { createTestRenderer } = await import('@opentui/core/testing')
const { createRoot } = await import('@opentui/react')
const { chatClient } = await import('@super-line/plugin-chat/client')
const { auth, AuthProvider, createTuiAuth } = await import('./auth')
const { App } = await import('./app')
const { LineProvider, ChatProvider, useMessages } = await import('./hooks')
const { MessageView } = await import('./messages')
const { ResourcePane } = await import('./resources')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fail = (msg: string, frame?: string): never => {
  console.error(`\nSMOKE FAIL: ${msg}`)
  if (frame) console.error(frame)
  process.exit(1)
}

const PROBE = `tui-smoke ${randomUUID().slice(0, 8)}`
const email = `tui-smoke-${randomUUID()}@test.dev`

function Probe({ channelId, me }: { channelId: string; me: string }) {
  const messages = useMessages(channelId)
  const names = new Map<string, string>()
  return (
    <box flexDirection="column">
      {messages.map((m) => (
        <MessageView key={m.id} m={m as FeedMessage} me={me} names={names} />
      ))}
    </box>
  )
}

// 1. register a throwaway user (singleton auth, isolated temp cache)
await auth.ready
await auth.signUp({ email, password: 'password123', displayName: 'Smoke' })
const me = auth.state.userId
if (!me) fail('signUp did not yield a userId')
console.log(`registered ${email} → ${me}`)

// 2. create a channel, join, send a message
const chat = chatClient(auth.client, { userId: me })
await chat.ready
const ch = await chat.createChannel({ name: `smoke-${Date.now()}` })
await chat.join(ch.id).catch(() => {}) // creating a channel already makes you a member — join is idempotent
await chat.send(ch.id, PROBE)
console.log(`created #${ch.name} (${ch.id}); sent probe "${PROBE}"`)

// 3. render the REAL transcript for that channel and poll until the probe text appears
const t = await createTestRenderer({ width: 100, height: 24 })
createRoot(t.renderer).render(
  <LineProvider client={auth.client}>
    <ChatProvider chat={chat}>
      <Probe channelId={ch.id} me={me!} />
    </ChatProvider>
  </LineProvider>,
)
let rendered = false
for (let i = 0; i < 60; i++) {
  await t.renderOnce()
  if (t.captureCharFrame().includes(PROBE)) {
    rendered = true
    break
  }
  await sleep(100)
}
const probeFrame = t.captureCharFrame()
t.renderer.destroy()
if (!rendered) fail('probe message did not render via useMessages', probeFrame)
console.log('OK — probe message rendered live through the real transcript.')

// 4. file-cache: the token was written, and a second boot restores the session without a login
if (!existsSync(cachePath)) fail('session cache file was not written')
const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { token?: string }
if (!cached.token) fail('session cache file has no token')
console.log(`OK — session cached to ${cachePath}`)

const boot2 = createTuiAuth()
await boot2.auth.ready
if (boot2.auth.state.status !== 'authed') fail('second boot did not restore the session from cache')
if (boot2.auth.state.userId !== me) fail('second boot restored a different user')
console.log('OK — a second boot skipped login (session restored from the cache file).')

// 5. the resource pane, live: the server auto-seeds every channel with a canvas + doc, so render the
// pane for our channel and prove (a) an AGENT write (writeResource) lands a note in the pane, (b) a
// human DocHandle edit re-renders it live, and (c) a partial x-only write preserves the text (the
// deep-merge the nudge/drag relies on).
const resStore = chat.resources(ch.id)
const offRes = resStore.subscribe(() => {})
let canvasDocId: string | undefined
for (let i = 0; i < 60; i++) {
  canvasDocId = resStore.rows().find((r) => r.kind === 'canvas')?.docId
  if (canvasDocId) break
  await sleep(200)
}
if (!canvasDocId) fail('channel canvas resource was not seeded by the server')
console.log(`OK — server seeded a canvas (docId ${canvasDocId}).`)

const p = await createTestRenderer({ width: 52, height: 30 })
createRoot(p.renderer).render(
  <ChatProvider chat={chat}>
    <box flexDirection="row" width={50} height={28}>
      <ResourcePane
        client={auth.client}
        channelId={ch.id}
        tab="canvas"
        focused={false}
        width={48}
        height={28}
        me={me!}
        names={new Map([[me!, 'Smoke']])}
        onSetTab={() => {}}
        onReturnToPrompt={() => {}}
      />
    </box>
  </ChatProvider>,
)
const waitForPane = async (needle: string, what: string): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    await p.renderOnce()
    if (p.captureCharFrame().includes(needle)) return
    await sleep(100)
  }
  fail(`${what} did not render in the pane (looking for "${needle}")`, p.captureCharFrame())
}

await waitForPane('Canvas', 'the seeded canvas')
console.log('OK — the pane opened the seeded canvas.')

const rid = randomUUID().slice(0, 4)
const noteId = `n-smoke-${rid}`
const noteText = `SMK-${rid}`
// DocHandle.update is typed shallow-Partial but document docs deep-merge nested partials (same cast
// the web resources.tsx uses so a text-only or x-only write doesn't demand the whole note).
const merge = (partial: unknown): Partial<CanvasDoc> => partial as Partial<CanvasDoc>
await chat.writeResource(ch.id, 'canvas', canvasDocId!, [
  { path: ['items', noteId], set: { x: 480, y: 300, color: '#fef08a', text: noteText } },
])
await waitForPane(noteText, 'an agent-written note')
console.log(`OK — agent writeResource note "${noteText}" rendered live in the pane.`)

// human edit path — a SECOND connection (boot2) edits the same doc via the native DocHandle (the
// exact useDoc.update deep-merge the pane writes through). A second handle on the pane's OWN
// connection would be echo-broken; a second connection is the real cross-client co-edit.
const handle = boot2.auth.client.collection('canvases').open(canvasDocId!)
await handle.ready.catch(() => {})
const editText = `EDT-${rid}`
handle.update(merge({ items: { [noteId]: { text: editText } } }))
await waitForPane(editText, 'a second-client DocHandle edit')
console.log(`OK — DocHandle edit "${editText}" from a second connection rendered live in the pane.`)

// partial x-only write must NOT clobber the text (the merge the nudge/drag rely on)
handle.update(merge({ items: { [noteId]: { x: 1180 } } }))
for (let i = 0; i < 8; i++) {
  await p.renderOnce()
  await sleep(80)
}
if (!p.captureCharFrame().includes(editText)) fail('x-only write clobbered the note text (deep-merge broken)', p.captureCharFrame())
console.log('OK — partial x-only write preserved the text (deep-merge intact).')
handle.close()
p.renderer.destroy()
offRes()
resStore.close()

// 6. capture one full cockpit-with-pane frame (App auto-selects #agents; the pane shows its canvas)
const c = await createTestRenderer({ width: 120, height: 34 })
createRoot(c.renderer).render(
  <AuthProvider>
    <App quit={() => {}} />
  </AuthProvider>,
)
for (let i = 0; i < 14; i++) {
  await c.renderOnce()
  await sleep(150)
}
const cockpit = c.captureCharFrame()
c.renderer.destroy()
if (!cockpit.includes('1 Canvas')) fail('the resource pane did not render in the full cockpit frame', cockpit)
const framePath = fileURLToPath(new URL('../../../../.scratch/chat-supervisor-tui/assets/tui-pane-frame.txt', import.meta.url))
writeFileSync(framePath, cockpit)
console.log(`\n=== full cockpit-with-pane frame (120x34) → ${framePath} ===\n${cockpit}`)

await auth.signOut().catch(() => {})
console.log('\nSMOKE PASS')
process.exit(0)
