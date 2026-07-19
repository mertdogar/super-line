// The cockpit: harness screen composition (topbar / transcript / status / prompt / dialog overlays)
// wired to the real plugin-chat + plugin-auth hooks. Keyboard ownership follows the harness
// discipline: the prompt owns keys unless a modal is up. The resource pane is a later ticket — the
// COMMANDS table and layout leave a clean seam for it (Prompt keeps its optional onFocusPane).

import { useEffect, useMemo, useState } from 'react'
import { useTerminalDimensions } from '@opentui/react'
import type { SuperLineClient } from '@super-line/client'
import { COLORS } from './theme'
import { GradientSpinner } from './spinner'
import { Prompt } from './prompt'
import { Dialog } from './dialog'
import { MessageView } from './messages'
import { ChannelPicker, Login, SessionInfo } from './pickers'
import { ResourcePane } from './resources'
import { COMMANDS } from './commands'
import { config } from './config'
import { useAuth } from './auth'
import {
  ChatProvider,
  LineProvider,
  chatClient,
  useChannels,
  useChat,
  useCollection,
  useMembers,
  useMessageParts,
  useMessages,
} from './hooks'
import type { app, FeedMessage } from '../contract'

type Modal = { kind: 'channels' } | { kind: 'session' }
type Client = SuperLineClient<typeof app, 'user'>

export function App({ quit }: { quit: () => void }) {
  const { ready, state, client, signIn, signUp, signOut } = useAuth()

  if (!ready) {
    return <Centered text="Connecting…" />
  }
  if (state.status !== 'authed') {
    return (
      <Dialog title="Sign in to chat-supervisor" footer="an account is created automatically if none exists">
        <Login onSignIn={signIn} onSignUp={signUp} />
      </Dialog>
    )
  }
  return (
    <Authed
      client={client as Client}
      me={state.userId ?? ''}
      name={state.displayName ?? state.userId ?? 'you'}
      onSwitchAccount={() => void signOut()}
      quit={quit}
    />
  )
}

function Centered({ text }: { text: string }) {
  const { width, height } = useTerminalDimensions()
  return (
    <box width={width} height={height} justifyContent="center" alignItems="center">
      <text fg={COLORS.dim}>{text}</text>
    </box>
  )
}

function Authed({
  client,
  me,
  name,
  onSwitchAccount,
  quit,
}: {
  client: Client
  me: string
  name: string
  onSwitchAccount: () => void
  quit: () => void
}) {
  const chat = useMemo(() => chatClient<typeof app, 'user'>(client, { userId: me }), [client, me])
  useEffect(() => () => chat.close(), [chat])
  return (
    <LineProvider client={client}>
      <ChatProvider chat={chat}>
        <Cockpit client={client} me={me} name={name} onSwitchAccount={onSwitchAccount} quit={quit} />
      </ChatProvider>
    </LineProvider>
  )
}

function useConnected(client: Client): boolean {
  const [connected, setConnected] = useState(client.connected)
  useEffect(() => {
    // super-line exposes `connected` + `onReconnect` but no connect/disconnect event — poll to catch
    // drops, and take the reconnect edge immediately.
    const tick = () => setConnected(client.connected)
    tick()
    const id = setInterval(tick, 1000)
    const off = client.onReconnect(tick)
    return () => {
      clearInterval(id)
      off()
    }
  }, [client])
  return connected
}

let noticeSeq = 0

function Cockpit({
  client,
  me,
  name,
  onSwitchAccount,
  quit,
}: {
  client: Client
  me: string
  name: string
  onSwitchAccount: () => void
  quit: () => void
}) {
  const { width, height } = useTerminalDimensions()
  const chat = useChat()
  const channels = useChannels()
  const users = useCollection('users').rows
  const [activeId, setActiveId] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  const [notices, setNotices] = useState<{ id: number; text: string }[]>([])
  const [paneOpen, setPaneOpen] = useState(true)
  const [tab, setTab] = useState<'canvas' | 'doc'>('canvas')
  const [focus, setFocus] = useState<'prompt' | 'pane'>('prompt')
  const connected = useConnected(client)

  // null-tolerant hooks (0.6.0): no channel selected = clean idle state, no '' hack, no subscription
  const active = channels.find((c) => c.id === activeId) ?? channels[0]
  const messages = useMessages(active?.id ?? null)
  const members = useMembers(active?.id ?? null)
  // derived from the feed we already hold; `useChannelBusy(id)` gives the same signal standalone
  // for components that DON'T subscribe to the channel's messages
  const busy = messages.some((m) => (m as FeedMessage).status === 'streaming')
  const names = useMemo(() => new Map(users.map((u) => [u.id, u.displayName])), [users])

  // The pane is a right split ≥96 cols wide (auto-hidden narrower — chat-only). Keyboard ownership:
  // the prompt owns keys unless the pane is focused (Tab on an empty prompt) or a modal is up.
  const showPane = paneOpen && width >= 96 && !!active
  const paneW = Math.min(48, Math.max(36, Math.floor(width * 0.36)))
  const paneFocused = focus === 'pane' && !modal && showPane
  useEffect(() => {
    if (!showPane && focus === 'pane') setFocus('prompt')
  }, [showPane, focus])

  const select = (id: string) => {
    setActiveId(id)
    void chat.join(id).catch(() => {})
  }

  // Land on the first channel once the directory arrives (fresh users auto-join #agents server-side).
  useEffect(() => {
    if (!activeId && channels[0]) select(channels[0].id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, activeId])

  const notice = (text: string) => setNotices((prev) => [...prev, { id: noticeSeq++, text }].slice(-40))

  const dispatch = (line: string) => {
    const [cmd, ...rest] = line.slice(1).split(' ')
    const arg = rest.join(' ').trim()
    switch (cmd) {
      case 'channels':
        setModal({ kind: 'channels' })
        break
      case 'new':
        if (!arg) notice('usage: /new <name>')
        else
          void chat
            .createChannel({ name: arg })
            .then((ch) => select(ch.id))
            .catch((e) => notice(`create failed: ${errText(e)}`))
        break
      case 'who':
        if (!active) notice('no channel')
        else
          notice(
            `members of #${active.name}: ${members.map((m) => `${names.get(m.userId) ?? m.userId} (${m.role})`).join(', ') || '—'}`,
          )
        break
      case 'resources':
        setPaneOpen((v) => !v)
        break
      case 'canvas':
        setPaneOpen(true)
        setTab('canvas')
        break
      case 'doc':
        setPaneOpen(true)
        setTab('doc')
        break
      case 'cancel': {
        // native cancel (0.5.0) + the §10 settle contract: the server settles the row `aborted`
        // and signals the runtime's writer — the model run unwinds via writer.signal
        const streamingMsg = messages.find((m) => (m as FeedMessage).status === 'streaming')
        if (!streamingMsg) notice('nothing is streaming')
        else
          void chat
            .cancelMessage(streamingMsg.id, 'cancelled from the cockpit')
            .then(() => notice('turn cancelled'))
            .catch((e) => notice(`cancel failed: ${errText(e)}`))
        break
      }
      case 'session':
        setModal({ kind: 'session' })
        break
      case 'login':
        onSwitchAccount()
        break
      case 'help':
        notice(COMMANDS.map((c) => `/${c.name}${c.arg ? ` <${c.arg}>` : ''} — ${c.desc}`).join('\n'))
        break
      case 'quit':
        quit()
        break
      default:
        notice(`unknown command: /${cmd}`)
    }
  }

  const submit = (line: string) => {
    if (line.startsWith('/')) return dispatch(line)
    if (!active) return notice('no channel — /new <name> to create one')
    void chat.send(active.id, line).catch((e) => notice(`send failed: ${errText(e)}`))
  }

  const promptFocused = !modal && focus === 'prompt'
  const idleHint = showPane ? '⏎ send · / commands · ⇥ resources · ^C quit' : '⏎ send · / commands · ^C quit'

  return (
    <box flexDirection="column" width={width} height={height}>
      <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={1}>
        <text fg={COLORS.accent}>{`# ${active?.name ?? '—'}`}</text>
        {active ? <text fg={COLORS.dim}>{`· ${members.length} members`}</text> : null}
        <box flexGrow={1} />
        <text fg={connected ? COLORS.green : COLORS.yellow}>{connected ? '● connected' : '◌ connecting…'}</text>
        <text fg={COLORS.dim}>{`${name} · ${config.url}`}</text>
      </box>

      <box flexDirection="row" flexGrow={1}>
        <scrollbox scrollY stickyScroll stickyStart="bottom" flexGrow={1} paddingLeft={1} paddingRight={1}>
          {!active ? <text fg={COLORS.dim}>{'no channel yet — /new <name> to create one'}</text> : null}
          {messages.map((m) => (
            <LiveMessageView key={m.id} m={m as FeedMessage} me={me} names={names} />
          ))}
          {notices.map((n) => (
            <box key={n.id} paddingTop={1}>
              <text fg={COLORS.dim}>{n.text}</text>
            </box>
          ))}
        </scrollbox>
        {showPane && active ? (
          <ResourcePane
            client={client}
            channelId={active.id}
            tab={tab}
            focused={paneFocused}
            width={paneW}
            height={height - 5}
            me={me}
            names={names}
            onSetTab={setTab}
            onReturnToPrompt={() => setFocus('prompt')}
          />
        ) : null}
      </box>

      <box flexDirection="row" paddingLeft={1} gap={1} height={1}>
        {busy ? <GradientSpinner /> : null}
        <text fg={COLORS.dim}>{busy ? 'supervisor is responding…' : idleHint}</text>
      </box>

      <Prompt
        placeholder={`Message #${active?.name ?? 'channel'} — / for commands`}
        focused={promptFocused}
        onSubmit={submit}
        onFocusPane={showPane ? () => setFocus('pane') : undefined}
      />

      {modal?.kind === 'channels' ? (
        <Dialog title="Channels" footer="↑↓ move · ⏎ switch · d leave · ＋ new · esc close">
          <ChannelPicker
            channels={channels}
            currentId={active?.id ?? ''}
            onSwitch={(id) => {
              select(id)
              setModal(null)
            }}
            onNew={(nm) => {
              setModal(null)
              void chat
                .createChannel({ name: nm })
                .then((ch) => select(ch.id))
                .catch((e) => notice(`create failed: ${errText(e)}`))
            }}
            onLeave={(id) => {
              setModal(null)
              void chat.leave(id).catch((e) => notice(`leave failed: ${errText(e)}`))
            }}
            onClose={() => setModal(null)}
          />
        </Dialog>
      ) : null}

      {modal?.kind === 'session' ? (
        <Dialog title="Session" footer="esc close">
          <SessionInfo
            rows={[
              { label: 'user', value: `${name} (${me})` },
              { label: 'channel', value: active ? `#${active.name} (${active.id})` : '—' },
              { label: 'server', value: config.url },
              { label: 'transport', value: 'websocket' },
              { label: 'connection', value: connected ? 'connected' : 'connecting' },
              { label: 'session', value: `cached · ${config.cachePath}` },
            ]}
            onClose={() => setModal(null)}
          />
        </Dialog>
      ) : null}
    </box>
  )
}

function LiveMessageView({ m, me, names }: { m: FeedMessage; me: string; names: Map<string, string> }) {
  if (m.status === undefined) return <MessageView m={m} me={me} names={names} />
  return <StreamedMessageView m={m} me={me} names={names} />
}

function StreamedMessageView({ m, me, names }: { m: FeedMessage; me: string; names: Map<string, string> }) {
  const parts = useMessageParts(m.channelId, m.id)
  return <MessageView m={m} me={me} names={names} parts={parts} />
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
