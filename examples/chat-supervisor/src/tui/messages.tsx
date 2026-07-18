// Transcript rendering: the harness visual vocabulary (delegation lanes as bordered cards, tool
// glyph/color from part state, dim `think` prefix) over plugin-chat's real arrival-ordered parts.
// The part-walking mirrors the web chat.tsx groupTurn/DelegationCard — parent-tagged parts bucket
// into their delegate anchor.

import { COLORS, agentGlyph, laneColor, statusColor, toolColor, toolGlyph, toolLabel } from './theme'
import type { FeedMessage, MessagePart } from '../contract'

const BODY_LIMIT = 240

function truncate(text: string): string {
  if (text.length <= BODY_LIMIT) return text
  return `${text.slice(0, BODY_LIMIT)}…[+${text.length - BODY_LIMIT} chars]`
}

function short(value: unknown): string {
  const s = JSON.stringify(value)
  return s.length > 44 ? `${s.slice(0, 44)}…` : s
}

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

interface ResourceCard {
  action: string
  kind: string
  docId: string
  title: string
}

function resourceOf(m: FeedMessage): ResourceCard | undefined {
  return (m.metadata as { resource?: ResourceCard } | undefined)?.resource
}

function contentText(m: FeedMessage): string {
  const c = m.content
  return typeof c === 'string' ? c : c === undefined ? '' : JSON.stringify(c)
}

// ── grouping: fold each delegate subtree into a card (web chat.tsx groupTurn) ──────────────────────

type Group = { kind: 'part'; part: MessagePart } | { kind: 'card'; anchor: MessagePart; children: MessagePart[] }

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

function ToolRow({ part }: { part: MessagePart }) {
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={toolColor(part.state, part.isError)}>{toolGlyph(part.state, part.isError)}</text>
        <text fg={COLORS.text}>{toolLabel(part.toolName ?? 'tool')}</text>
        {part.args !== undefined ? <text fg={COLORS.dim}>{short(part.args)}</text> : null}
      </box>
      {part.result !== undefined ? (
        <box paddingLeft={2}>
          <text fg={COLORS.dim}>{short(part.result)}</text>
        </box>
      ) : null}
    </box>
  )
}

function DelegationCard({ anchor, parts, streaming }: { anchor: MessagePart; parts: MessagePart[]; streaming: boolean }) {
  const args = anchor.args as { agentType?: string; task?: string } | undefined
  const agentType = args?.agentType ?? 'subagent'
  const task = args?.task ? `: ${args.task}` : ''
  return (
    <box border borderStyle="rounded" borderColor={COLORS.border} paddingLeft={1} paddingRight={1} flexDirection="column">
      <text fg={laneColor(anchor.isError === true, anchor.done)}>{`${agentGlyph(agentType)} ${agentType}${task}`}</text>
      {parts.length === 0 ? <text fg={COLORS.dim}>starting…</text> : null}
      {parts.map((child) => (
        <PartView key={child.id} part={child} live={streaming && !child.done} />
      ))}
    </box>
  )
}

function PartView({ part, live }: { part: MessagePart; live: boolean }) {
  if (part.type === 'reasoning') {
    return (
      <box flexDirection="row">
        <text fg={COLORS.dim}>{'think  '}</text>
        <text fg={COLORS.dim} flexGrow={1}>
          {`${truncate(part.text)}${live ? '▌' : ''}`}
        </text>
      </box>
    )
  }
  if (part.type === 'tool') return <ToolRow part={part} />
  return <text fg={COLORS.text}>{`${part.text}${live ? '▌' : ''}`}</text>
}

function ResourceCardLine({ card, m }: { card: ResourceCard; m: FeedMessage }) {
  return (
    <box flexDirection="row" gap={1} paddingTop={1}>
      <text fg={COLORS.cyan}>⧉</text>
      <text fg={COLORS.cyan}>{`${card.kind} “${card.title}” ${card.action}`}</text>
      <text fg={COLORS.dim}>{time(m.createdAt)}</text>
    </box>
  )
}

function Turn({ m }: { m: FeedMessage }) {
  const parts = m.parts ?? []
  const streaming = m.status === 'streaming'
  if (parts.length === 0) {
    // an old turn whose parts left the recency window — its content projection carries it
    return <text fg={COLORS.text}>{contentText(m)}</text>
  }
  return (
    <box flexDirection="column">
      {groupTurn(parts).map((g) =>
        g.kind === 'card' ? (
          <DelegationCard key={g.anchor.id} anchor={g.anchor} parts={g.children} streaming={streaming} />
        ) : (
          <PartView key={g.part.id} part={g.part} live={streaming && !g.part.done} />
        ),
      )}
      {m.status === 'aborted' ? <text fg={COLORS.dim}>{`⏹ interrupted${m.error ? ` — ${m.error}` : ''}`}</text> : null}
      {m.status === 'error' ? <text fg={COLORS.red}>{`⚠ ${m.error ?? 'failed'}`}</text> : null}
    </box>
  )
}

export function MessageView({ m, me, names }: { m: FeedMessage; me: string; names: Map<string, string> }) {
  const card = resourceOf(m)
  if (card) return <ResourceCardLine card={card} m={m} />

  const bot = m.status !== undefined
  const mine = m.authorId === me

  if (bot) {
    return (
      <box flexDirection="column" paddingTop={1}>
        <box flexDirection="row" gap={1}>
          <text fg={COLORS.purple}>{`◇ ${names.get(m.authorId) ?? 'Supervisor'}`}</text>
          {m.status !== 'complete' ? <text fg={statusColor(m.status)}>{m.status}</text> : null}
          <text fg={COLORS.dim}>{time(m.createdAt)}</text>
        </box>
        <box paddingLeft={2} flexDirection="column">
          <Turn m={m} />
        </box>
      </box>
    )
  }

  const author = mine ? 'you' : (names.get(m.authorId) ?? 'member')
  return (
    <box flexDirection="column" paddingTop={1}>
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.userBorder}>▌</text>
        <text fg={COLORS.accent}>{author}</text>
        <text fg={COLORS.dim}>{time(m.createdAt)}</text>
      </box>
      <box paddingLeft={2}>
        <text fg={COLORS.text}>{contentText(m)}</text>
      </box>
    </box>
  )
}
