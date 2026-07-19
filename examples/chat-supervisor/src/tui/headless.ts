// The headless stdin/stdout shell (ticket 08) — the cockpit's second face for agents and scripts.
// No OpenTUI: it reuses the SAME plain clients as the cockpit (authClient / chatClient) against the
// dev server, and speaks the protocol locked in ticket 04:
//
//  • human mode  — `<<READY>>`/`<<TURN_START>>`/`<<TURN_DONE>>`/`<<ERROR>>`/`<<DISCONNECTED>>`/
//                  `<<RECONNECTED>>`/`<<RESUME>>` markers + `#channel author: text` lines + `⧉` resource lines.
//  • --json      — pure JSONL of the curated event types (headless-emit.ts).
//
// Input is the current-channel model: a bare line sends to the current channel; `--channel`/`/channel`
// pick it; commands are `/channels /channel /new /who /session /help /quit`. Input arrives on stdin
// or, with `--control`, a reopen-in-a-loop FIFO. Auth is the cockpit-written session file (or a
// `--token`/`CHAT_SUPERVISOR_TOKEN` override) — never an interactive prompt.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as readline from 'node:readline'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { authClient } from '@super-line/plugin-auth/client'
import type { TokenStorage } from '@super-line/plugin-auth/client'
import { chatClient } from '@super-line/plugin-chat/client'
import { app } from '../contract'
import type { FeedMessage, MessagePart } from '../contract'
import type { Config } from './config'
import { fileStorage } from './storage'
import { COMMANDS } from './commands'
import type { Command } from './commands'
import { makeEmitter } from './headless-emit'
import { FeedDiffer } from './headless-feed'

/** `/channels /channel /new /who /session /help /quit` — the cockpit table minus `/login` (no headless equivalent) plus `/channel`. */
const CHANNEL_CMD: Command = { name: 'channel', arg: 'name', desc: 'switch to a channel', takesArg: true }
const HEADLESS_COMMANDS: Command[] = COMMANDS.flatMap((c) =>
  c.name === 'login' ? [] : c.name === 'channels' ? [c, CHANNEL_CMD] : [c],
)

function die(msg: string): never {
  process.stderr.write(`chat-supervisor (headless): ${msg}\n`)
  process.exit(2)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function runHeadless(config: Config): Promise<void> {
  // ── auth: token from --token/env or the cached session file; never interactive ──────────────────
  const token = config.token ?? fileStorage(config.cachePath).get()
  if (!token) {
    die('no session found — run the cockpit once (pnpm tui) to sign in, or pass --token / CHAT_SUPERVISOR_TOKEN')
  }
  const tokenStorage: TokenStorage = { get: () => token, set: () => {} }
  const auth = authClient<typeof app, 'user'>({
    authedRole: 'user',
    storage: tokenStorage,
    connect: ({ role, params }) =>
      createSuperLineClient(app, {
        transport: webSocketClientTransport({ url: config.url }),
        role: role as 'user',
        params,
        crdtCollections: crdtCollectionsClient(),
      }),
  })
  await auth.ready
  if (auth.state.status !== 'authed') {
    die('session expired or invalid — sign in again with the cockpit (pnpm tui), or pass a fresh --token')
  }
  const me = auth.state.userId
  if (!me) die('authenticated but no user id resolved')
  const myName = auth.state.displayName ?? me
  const client = auth.client

  const chat = chatClient<typeof app, 'user'>(client, { userId: me })
  await chat.ready

  const emitter = makeEmitter({ json: config.json, me, spillDir: config.spillDir })
  const info = (kind: string, text: string, data?: unknown): void =>
    emitter.emit({ type: 'info', kind, text, ...(data !== undefined ? { data } : {}) })

  // ── live directories: channels + the users name map ─────────────────────────────────────────────
  const channelsStore = chat.channels()
  const usersLive = client.collection('users').subscribe({})
  const namesMap = new Map<string, string>()
  const rebuildNames = (): void => {
    namesMap.clear()
    for (const u of usersLive.rows() as { id: string; displayName: string }[]) namesMap.set(u.id, u.displayName)
  }
  usersLive.subscribe(rebuildNames)
  void usersLive.ready.then(rebuildNames)
  const names = (): Map<string, string> => namesMap
  await channelsStore.ready
  rebuildNames()

  type Channel = { id: string; name: string }
  const channelRows = (): { id: string; name: string; visibility?: string }[] =>
    channelsStore.rows() as { id: string; name: string; visibility?: string }[]
  const findChannel = (raw: string): Channel | undefined => {
    const wanted = raw.replace(/^#/, '')
    return channelRows().find((c) => c.name === wanted || c.id === wanted)
  }

  // ── the current channel + its live feed differ ──────────────────────────────────────────────────
  let current: Channel | null = null
  let feedUnsub: () => void = () => {}
  let closeParts: () => void = () => {}
  let feedStore: ReturnType<typeof chat.messages> | null = null

  const openChannel = async (ch: Channel): Promise<void> => {
    feedUnsub()
    closeParts()
    feedStore?.close()
    current = ch
    void chat.join(ch.id).catch(() => {}) // idempotent; guarantees read access + the delta room
    const store = chat.messages(ch.id)
    feedStore = store
    const differ = new FeedDiffer({ channel: ch.name, me, names })
    const partsByMessage = new Map<string, MessagePart[]>()
    const partStores = new Map<string, { store: ReturnType<typeof chat.messageParts>; unsubscribe: () => void }>()
    closeParts = (): void => {
      for (const mounted of partStores.values()) {
        mounted.unsubscribe()
        mounted.store.close()
      }
      partStores.clear()
      partsByMessage.clear()
    }
    let primed = false
    const emit = (): void => {
      if (primed && feedStore === store) emitter.emitAll(differ.sync(store.rows() as FeedMessage[], partsByMessage))
    }
    const mountParts = async (message: FeedMessage): Promise<void> => {
      if (partStores.has(message.id)) return
      const parts = chat.messageParts(ch.id, message.id)
      const update = (): void => {
        partsByMessage.set(message.id, parts.rows() as MessagePart[])
        emit()
      }
      const unsubscribe = parts.subscribe(update)
      partStores.set(message.id, { store: parts, unsubscribe })
      await parts.ready
      update()
    }
    const reconcile = async (): Promise<void> => {
      const rows = store.rows() as FeedMessage[]
      const detailed = new Set(rows.filter((message) => message.status !== undefined).map((message) => message.id))
      for (const message of rows) if (message.status !== undefined) await mountParts(message)
      for (const [messageId, mounted] of partStores) {
        if (detailed.has(messageId)) continue
        mounted.unsubscribe()
        mounted.store.close()
        partStores.delete(messageId)
        partsByMessage.delete(messageId)
      }
      emit()
    }
    feedUnsub = store.subscribe(() => void reconcile())
    await store.ready
    if (feedStore !== store) return // switched again while awaiting — the newer open owns the feed
    await reconcile()
    differ.prime(store.rows() as FeedMessage[], partsByMessage) // backlog is context, not events
    primed = true
  }

  // ── connection status: poll `connected` (no connect/disconnect event) + take the reconnect edge ──
  let connectedState = client.connected
  const connTimer = setInterval(() => {
    const now = client.connected
    if (now === connectedState) return
    connectedState = now
    emitter.emit({ type: 'status', kind: now ? 'reconnected' : 'disconnected' })
  }, 1000)
  ;(connTimer as { unref?: () => void }).unref?.()
  const offReconnect = client.onReconnect(() => {
    if (!connectedState) {
      connectedState = true
      emitter.emit({ type: 'status', kind: 'reconnected' })
    }
  })

  // ── land on the initial channel, then announce READY ────────────────────────────────────────────
  const initial = config.channel ? findChannel(config.channel) : channelRows()[0]
  if (initial) await openChannel(initial)
  if (config.control) ensureFifo(config.control) // create the node BEFORE READY so a driver can open it

  emitter.emit({ type: 'status', kind: 'ready', user: myName, channel: initial ? initial.name : '—' })

  // ── shutdown: RESUME line, teardown, clean exit ─────────────────────────────────────────────────
  let closing = false
  const resumeCommand = (): string => {
    const parts = ['bun', 'src/tui/index.tsx', '--headless']
    if (current) parts.push('--channel', current.name)
    if (config.json) parts.push('--json')
    if (config.url !== 'ws://localhost:8792/super-line') parts.push('--url', config.url)
    return parts.join(' ')
  }
  const shutdown = (): void => {
    if (closing) return
    closing = true
    emitter.emit({ type: 'status', kind: 'resume', command: resumeCommand() })
    clearInterval(connTimer)
    offReconnect()
    feedUnsub()
    closeParts()
    feedStore?.close()
    channelsStore.close()
    usersLive.close()
    chat.close()
    client.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ── command dispatch (shared vocabulary with the cockpit) ───────────────────────────────────────
  const dispatch = async (line: string): Promise<'quit' | void> => {
    const [cmd, ...rest] = line.slice(1).split(' ')
    const arg = rest.join(' ').trim()
    switch (cmd) {
      case 'channels': {
        const rows = channelRows()
        const data = rows.map((c) => ({ id: c.id, name: c.name, visibility: c.visibility, current: c.id === current?.id }))
        const text =
          rows.length === 0
            ? '(no channels)'
            : rows.map((c) => `${c.id === current?.id ? '▸' : ' '} #${c.name} (${c.id})`).join('\n')
        info('channels', text, data)
        return
      }
      case 'channel': {
        if (!arg) return info('error', 'usage: /channel <name>')
        const ch = findChannel(arg)
        if (!ch) return info('error', `no channel named ${arg}`)
        await openChannel({ id: ch.id, name: ch.name })
        return info('channel', `switched to #${ch.name}`, { id: ch.id, name: ch.name })
      }
      case 'new': {
        if (!arg) return info('error', 'usage: /new <name>')
        try {
          const ch = (await chat.createChannel({ name: arg })) as Channel
          await openChannel({ id: ch.id, name: ch.name })
          info('channel', `created #${ch.name}`, { id: ch.id, name: ch.name })
        } catch (e) {
          emitter.emit({ type: 'error', message: errText(e) })
        }
        return
      }
      case 'who': {
        if (!current) return info('error', 'no channel')
        const ms = chat.members(current.id)
        try {
          await ms.ready
          const rows = ms.rows() as { userId: string; role: string }[]
          const data = rows.map((r) => ({ userId: r.userId, name: names().get(r.userId) ?? r.userId, role: r.role }))
          const text = `members of #${current.name}: ${data.map((d) => `${d.name} (${d.role})`).join(', ') || '—'}`
          info('who', text, data)
        } finally {
          ms.close()
        }
        return
      }
      case 'cancel': {
        // native cancel: the server settles the row `aborted` and signals the producer (§10 of the
        // 0.5 migration guide) — scripts see the terminal status arrive as a normal turn_done
        const streaming = (feedStore?.rows() as FeedMessage[] | undefined)?.find((m) => m.status === 'streaming')
        if (!streaming) return info('error', 'nothing is streaming')
        try {
          await chat.cancelMessage(streaming.id, 'cancelled from the headless shell')
          info('cancel', `cancelled ${streaming.id}`, { messageId: streaming.id })
        } catch (e) {
          emitter.emit({ type: 'error', message: errText(e) })
        }
        return
      }
      case 'session': {
        const data = {
          user: `${myName} (${me})`,
          channel: current ? `#${current.name} (${current.id})` : '—',
          server: config.url,
          transport: 'websocket',
          connection: client.connected ? 'connected' : 'disconnected',
          session: config.token ? 'token override' : `cached · ${config.cachePath}`,
          control: config.control ?? 'stdin',
        }
        const text = Object.entries(data)
          .map(([k, v]) => `${k.padEnd(12)} ${v}`)
          .join('\n')
        info('session', text, data)
        return
      }
      case 'help': {
        const text = HEADLESS_COMMANDS.map((c) => `/${c.name}${c.arg ? ` <${c.arg}>` : ''} — ${c.desc}`).join('\n')
        info('help', text, HEADLESS_COMMANDS.map((c) => ({ name: c.name, arg: c.arg, desc: c.desc })))
        return
      }
      case 'quit':
        shutdown()
        return 'quit'
      default:
        info('error', `unknown command: /${cmd}`)
        return
    }
  }

  const handleLine = async (raw: string): Promise<'quit' | void> => {
    const line = raw.trim()
    if (!line) return
    if (line.startsWith('/')) return dispatch(line)
    if (!current) return info('error', 'no channel — /new <name> to create one')
    try {
      await chat.send(current.id, line)
    } catch (e) {
      emitter.emit({ type: 'error', message: errText(e) })
    }
  }

  // ── input pumps ─────────────────────────────────────────────────────────────────────────────────
  const pumpStdin = async (): Promise<void> => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    for await (const l of rl) {
      if ((await handleLine(l)) === 'quit') {
        rl.close()
        return
      }
    }
  }
  const pumpControl = async (path: string): Promise<void> => {
    // A named pipe delivers EOF once its current writer closes — reopen in a loop so many separate
    // `echo … > fifo` writes all land (only /quit breaks it for good).
    for (;;) {
      const stream = createReadStream(path, { encoding: 'utf8' })
      const rl = readline.createInterface({ input: stream, terminal: false })
      for await (const l of rl) {
        if ((await handleLine(l)) === 'quit') {
          rl.close()
          stream.close()
          return
        }
      }
      rl.close()
      stream.close()
      if (closing) return
    }
  }

  if (config.control) void pumpControl(config.control).then(shutdown)
  else void pumpStdin().then(shutdown)
}

function ensureFifo(path: string): void {
  if (!existsSync(path)) {
    execFileSync('mkfifo', [path])
    return
  }
  if (!statSync(path).isFIFO()) die(`--control path exists and is not a FIFO: ${path}`)
}
