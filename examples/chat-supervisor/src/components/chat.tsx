// One channel, one feed — the point of this example is the MESSAGE RENDERING: a streamed
// supervisor turn arrives as a tree of parts, and every delegation renders as its own CARD
// (the subagent's reasoning, tool calls, and text live inside it), exactly like super-harness's
// web cockpit — but everything here is plain plugin-chat rows, durable across reloads.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Bot, Menu, PanelRight, Send, User as UserIcon, Wrench } from 'lucide-react'
import { useChannels, useChat, useMessageParts, useMessages } from '@/App'
import { Sidebar } from '@/components/sidebar'
import { ResourcePane } from '@/components/resources'
import type { FeedMessage, MessagePart } from '@/contract'

export function Chat({ me, myName, onSignOut }: { me: string; myName: string; onSignOut: () => void }): React.JSX.Element {
  const chat = useChat()
  const channels = useChannels()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  const [paneOpen, setPaneOpen] = useState(false) // <lg only — the pane is always visible on lg+
  const active = channels.find((c) => c.id === activeId) ?? channels[0]

  const select = (id: string): void => {
    setActiveId(id)
    setNavOpen(false)
    void chat.join(id).catch(() => {}) // join-on-select (public channels); already-a-member is fine
  }
  const create = (name: string): void => {
    void chat
      .createChannel({ name })
      .then((ch) => setActiveId(ch.id))
      .catch(() => {})
  }

  return (
    <div className="flex h-full bg-background">
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" aria-hidden onClick={() => setNavOpen(false)} />}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform md:static md:z-auto md:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        <Sidebar
          myName={myName}
          channels={channels}
          activeId={active?.id ?? ''}
          onSelect={select}
          onCreate={create}
          onSignOut={onSignOut}
        />
      </div>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-3 shadow-sm">
          <button
            onClick={() => setNavOpen(true)}
            aria-label="Open channel list"
            className="-ml-1 grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
          >
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="font-bold">#{active?.name ?? 'agents'}</h1>
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">
            — a supervisor that delegates; subagents stream in cards
          </span>
          <button
            onClick={() => setPaneOpen(true)}
            aria-label="Open resources"
            className="ml-auto grid h-8 w-8 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <PanelRight className="h-5 w-5" />
          </button>
        </header>
        {active ? <Feed key={active.id} channelId={active.id} me={me} /> : <div className="flex-1" />}
      </section>

      {paneOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" aria-hidden onClick={() => setPaneOpen(false)} />}
      <div
        className={`fixed inset-y-0 right-0 z-40 w-[85vw] max-w-[26rem] transition-transform lg:static lg:z-auto lg:w-[24rem] lg:shrink-0 lg:translate-x-0 xl:w-[27rem] ${
          paneOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'
        }`}
      >
        {active && <ResourcePane key={active.id} channelId={active.id} me={me} />}
      </div>
    </div>
  )
}

function Feed({ channelId, me }: { channelId: string; me: string }): React.JSX.Element {
  const chat = useChat()
  const messages = useMessages(channelId)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {messages.length === 0 && (
            <p className="mt-8 text-center text-sm text-muted-foreground">
              Ask something that needs live data — “compare the weather in Ankara and Berlin” — or point at the
              shared canvas: “add a note for each of this sprint's goals”. Either way, watch the supervisor
              delegate.
            </p>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m as FeedMessage} mine={m.authorId === me} />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <Composer onSend={(text) => void chat.send(channelId, text).catch(() => {})} />
    </>
  )
}

function MessageRow({ m, mine }: { m: FeedMessage; mine: boolean }): React.JSX.Element {
  const bot = m.status !== undefined
  return (
    <div className="flex gap-3">
      <div
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${bot ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
      >
        {bot ? <Bot className="h-4 w-4" /> : <UserIcon className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{bot ? 'Supervisor' : mine ? 'You' : 'Member'}</span>
          <span className="text-xs text-muted-foreground">
            {new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
        {bot ? <Turn m={m} /> : <PlainBody m={m} />}
      </div>
    </div>
  )
}

function PlainBody({ m }: { m: FeedMessage }): React.JSX.Element {
  const text = typeof m.content === 'string' ? m.content : m.content === undefined ? '' : JSON.stringify(m.content)
  return <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{text}</div>
}

// ── the streamed turn: root-lane parts inline, each delegation as a CARD ─────────────────────────

type ToolPart = Extract<MessagePart, { type: 'tool' }>
type Group = { kind: 'part'; part: MessagePart } | { kind: 'card'; anchor: ToolPart; children: MessagePart[] }

/** Parts arrive tree-ordered (anchor, then its subtree) — fold each delegate subtree into a card. */
function groupTurn(parts: MessagePart[]): Group[] {
  const groups: Group[] = []
  const cards = new Map<string, Group & { kind: 'card' }>()
  for (const p of parts) {
    if (p.parent !== null) {
      const card = cards.get(p.parent)
      if (card) {
        card.children.push(p)
        continue
      }
    }
    if (p.type === 'tool' && p.toolName === 'delegate' && p.toolCallId) {
      const card: Group & { kind: 'card' } = { kind: 'card', anchor: p, children: [] }
      cards.set(p.toolCallId, card)
      groups.push(card)
      continue
    }
    groups.push({ kind: 'part', part: p })
  }
  return groups
}

function Turn({ m }: { m: FeedMessage }): React.JSX.Element {
  const parts = useMessageParts(m.channelId, m.id)
  const streaming = m.status === 'streaming'
  if (parts.length === 0) return <PlainBody m={m} />
  return (
    <div className="space-y-2">
      {groupTurn(parts).map((g) =>
        g.kind === 'card' ? (
          <DelegationCard key={g.anchor.id} anchor={g.anchor} parts={g.children} streaming={streaming} />
        ) : (
          <PartView key={g.part.id} p={g.part} live={streaming && !g.part.done} />
        ),
      )}
      {streaming && parts.every((p) => p.done) && <Cursor />}
      {m.status === 'aborted' && (
        <div className="text-xs italic text-muted-foreground">⏹ interrupted{m.error ? ` — ${m.error}` : ''}</div>
      )}
      {m.status === 'error' && <div className="text-xs text-destructive">⚠ {m.error ?? 'failed'}</div>}
    </div>
  )
}

/**
 * One delegation = one card (the harness web-cockpit look): header names the subagent + its task
 * and carries a live status badge; the body is the subagent's OWN lane — reasoning, tool calls,
 * text — streaming inside the card, and still there after a reload.
 */
function DelegationCard({
  anchor,
  parts,
  streaming,
}: {
  anchor: ToolPart
  parts: MessagePart[]
  streaming: boolean
}): React.JSX.Element {
  const args = anchor.args as { agentType?: string; task?: string } | undefined
  const running = !anchor.done
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/30">
      <div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm">
          <span className="font-semibold">{args?.agentType ?? 'subagent'}</span>
          {args?.task && <span className="text-muted-foreground"> — {args.task}</span>}
        </span>
        <StatusBadge running={running && streaming} isError={anchor.isError === true} done={anchor.done} />
      </div>
      <div className="space-y-2 px-3 py-2">
        {parts.length === 0 && <div className="text-sm italic text-muted-foreground">starting…</div>}
        {parts.map((p) => (
          <PartView key={p.id} p={p} live={streaming && !p.done} />
        ))}
      </div>
    </div>
  )
}

function StatusBadge({ running, isError, done }: { running: boolean; isError: boolean; done: boolean }): React.JSX.Element {
  const label = isError ? 'error' : running ? 'running' : done ? 'completed' : 'interrupted'
  return (
    <span
      className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        isError
          ? 'bg-destructive/10 text-destructive'
          : running
            ? 'animate-pulse bg-primary/10 text-primary'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </span>
  )
}

function PartView({ p, live }: { p: MessagePart; live: boolean }): React.JSX.Element {
  if (p.type === 'text')
    return (
      <div className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
        {p.text}
        {live && <Cursor inline />}
      </div>
    )
  if (p.type === 'reasoning')
    return (
      <details open={live} className="text-sm text-muted-foreground">
        <summary className="cursor-pointer select-none text-xs font-medium">💭 Reasoning{live ? '…' : ''}</summary>
        <div className="whitespace-pre-wrap break-words italic">
          {p.text}
          {live && <Cursor inline />}
        </div>
      </details>
    )
  if (p.type === 'data') return <Json label="data" value={p.data} />
  const badge = p.isError ? 'error' : p.state === 'done' ? 'completed' : p.state === 'running' ? 'running' : 'input…'
  return (
    <details className="rounded-md border bg-background/70 px-2 py-1 text-sm">
      <summary className="flex cursor-pointer select-none items-center gap-2">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs">{p.toolName ?? p.toolCallId}</span>
        <span
          className={`rounded-full px-1.5 py-px text-[10px] font-medium ${p.isError ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
        >
          {badge}
        </span>
      </summary>
      {p.args !== undefined && <Json label="args" value={p.args} />}
      {p.result !== undefined && <Json label="result" value={p.result} />}
    </details>
  )
}

function Json({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-1.5 text-[11px] leading-snug text-muted-foreground">
      {label}: {JSON.stringify(value, null, 1)}
    </pre>
  )
}

function Cursor({ inline = false }: { inline?: boolean }): React.JSX.Element {
  return <span className={`${inline ? 'ml-0.5' : ''} inline-block h-4 w-[2px] animate-pulse bg-foreground align-middle`} />
}

function Composer({ onSend }: { onSend: (text: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const submit = (): void => {
    const t = text.trim()
    if (!t) return
    setText('')
    onSend(t)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  return (
    <div className="border-t px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-lg border border-input bg-background p-1.5 shadow-sm focus-within:ring-2 focus-within:ring-ring">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask the supervisor — a weather question, or “add three notes to the canvas”"
          rows={1}
          className="max-h-40 min-h-[40px] w-full resize-none bg-transparent px-2 py-2 text-sm focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          aria-label="Send"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground shadow hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
