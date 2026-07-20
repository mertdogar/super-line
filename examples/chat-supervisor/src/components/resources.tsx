// The channel's shared resources (PLAN-chat-resources): a sticky-note canvas and a block doc,
// both CRDT documents the human edits through the native DocHandle (useDoc) while the editor
// subagent writes through the acked writeResource path — the same doc, merging live. The registry
// rows come from the chat plugin (useChannelResources); presence is the coarse who's-open rows.

import { useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot, FileText, StickyNote, Trash2, ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { useChannelResources, useResourcePresence, useDoc, useCollection } from '@/App'
import type { CanvasDoc, ResourceRow, TextDoc } from '@/contract'

const PALETTE = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8']
const noteId = (): string => `n-${Math.random().toString(36).slice(2, 8)}`

// DocHandle.update's TYPE is a shallow Partial<Doc>, but document-mode docs deep-merge nested
// partials (that's what keeps a dragged x/y from clobbering concurrently-edited text) — one honest
// widening per editor instead of full-object writes that WOULD clobber.
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export function ResourcePane({ channelId, me }: { channelId: string; me: string }): React.JSX.Element {
  const rows = useChannelResources(channelId)
  const sorted = [...rows].sort((a, b) => a.kind.localeCompare(b.kind)) // canvas, then doc
  const [activeKind, setActiveKind] = useState<string | null>(null)
  const active = sorted.find((r) => r.kind === activeKind) ?? sorted[0]

  return (
    <aside className="flex h-full w-full flex-col border-l bg-background">
      <header className="flex items-center gap-1 border-b px-2 py-2">
        {sorted.map((r) => (
          <button type="button"
            key={r.id}
            onClick={() => setActiveKind(r.kind)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium ${
              r.id === active?.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {r.kind === 'canvas' ? <StickyNote className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            {r.title}
          </button>
        ))}
        {active && <Presence row={active} me={me} />}
      </header>
      {active ? (
        active.kind === 'canvas' ? (
          <CanvasBoard key={active.docId} docId={active.docId} />
        ) : (
          <DocEditor key={active.docId} docId={active.docId} />
        )
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
          Setting up this channel's canvas and doc…
        </div>
      )}
    </aside>
  )
}

/** Who has this doc open right now — the bot included, while its editor lane works. */
function Presence({ row, me }: { row: ResourceRow; me: string }): React.JSX.Element {
  const present = useResourcePresence(row)
  const { rows: users } = useCollection('users')
  const nameOf = (id: string): string => users.find((u) => u.id === id)?.displayName ?? '?'
  return (
    <div className="ml-auto flex items-center -space-x-1.5 pr-1">
      {present.map((p) => {
        const name = nameOf(p.userId)
        const bot = name === 'Supervisor'
        return (
          <span
            key={p.userId}
            title={p.userId === me ? `${name} (you)` : name}
            className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold uppercase ring-2 ring-background ${
              bot ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}
          >
            {bot ? <Bot className="h-3.5 w-3.5" /> : name.slice(0, 2)}
          </span>
        )
      })}
    </div>
  )
}

// ── canvas: draggable sticky notes ───────────────────────────────────────────────────────────────

function CanvasBoard({ docId }: { docId: string }): React.JSX.Element {
  const { data, update, delete: del } = useDoc('canvases', docId)
  const [color, setColor] = useState(PALETTE[0]!)
  const boardRef = useRef<HTMLDivElement>(null)
  // Keyed by pointerId so two fingers dragging two notes don't share one slot; each slot caches
  // the latest position so pointerup can flush the true drop point (the throttle skips frames).
  const drags = useRef<Map<number, { id: string; dx: number; dy: number; last: number; x: number; y: number }>>(new Map())
  const patch = (p: DeepPartial<CanvasDoc>): void => update(p as Partial<CanvasDoc>)

  if (!data) return <PaneLoading />
  const items = Object.entries(data.items ?? {})

  const addNote = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (e.target !== boardRef.current) return // only on the board itself, not on a note
    const rect = boardRef.current!.getBoundingClientRect()
    patch({
      items: { [noteId()]: { x: Math.max(0, e.clientX - rect.left - 88), y: Math.max(0, e.clientY - rect.top - 16), color, text: '' } },
    })
  }
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, id: string): void => {
    const rect = boardRef.current!.getBoundingClientRect()
    const it = data.items[id]
    if (!it) return
    drags.current.set(e.pointerId, { id, dx: e.clientX - rect.left - it.x, dy: e.clientY - rect.top - it.y, last: 0, x: it.x, y: it.y })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drags.current.get(e.pointerId)
    if (!d || !(d.id in (data.items ?? {}))) return // a concurrent delete drops the drag, never resurrects the note
    const rect = boardRef.current!.getBoundingClientRect()
    d.x = Math.max(0, e.clientX - rect.left - d.dx)
    d.y = Math.max(0, e.clientY - rect.top - d.dy)
    const now = performance.now()
    if (now - d.last < 40) return // ~25 updates/s is plenty on the wire; the final position flushes on pointerup
    d.last = now
    patch({ items: { [d.id]: { x: d.x, y: d.y } } })
  }
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drags.current.get(e.pointerId)
    if (!d) return
    drags.current.delete(e.pointerId)
    if (d.id in (data.items ?? {})) patch({ items: { [d.id]: { x: d.x, y: d.y } } }) // land on the true drop point
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
        <div ref={boardRef} onDoubleClick={addNote} className="relative h-[800px] w-[1200px]">
          {items.length === 0 && (
            <p className="pointer-events-none absolute left-1/2 top-24 w-64 -translate-x-1/2 text-center text-sm text-muted-foreground">
              Double-click to add a note — or ask the supervisor to fill the board.
            </p>
          )}
          {items.map(([id, it]) => (
            <div
              key={id}
              onPointerDown={(e) => startDrag(e, id)}
              onPointerMove={onDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className="group absolute w-44 cursor-grab touch-none rounded-md shadow-md active:cursor-grabbing"
              style={{ left: it.x, top: it.y, background: it.color }}
            >
              <button type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => del(['items', id])}
                aria-label="Delete note"
                className="absolute -right-2 -top-2 z-10 hidden h-5 w-5 place-items-center rounded-full bg-foreground/80 text-background shadow group-hover:grid"
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <textarea
                value={it.text ?? ''}
                onChange={(e) => patch({ items: { [id]: { text: e.target.value } } })}
                onPointerDown={(e) => e.stopPropagation()}
                placeholder="…"
                rows={Math.max(3, (it.text ?? '').split('\n').length)}
                className="w-full resize-none rounded-md bg-transparent p-2.5 text-sm text-neutral-800 placeholder:text-neutral-500/60 focus:outline-none"
              />
            </div>
          ))}
        </div>
      </div>
      <footer className="flex items-center gap-2 border-t px-3 py-2">
        {PALETTE.map((c) => (
          <button type="button"
            key={c}
            onClick={() => setColor(c)}
            aria-label={`New notes in ${c}`}
            className={`h-5 w-5 rounded-full ${c === color ? 'ring-2 ring-ring ring-offset-1' : ''}`}
            style={{ background: c }}
          />
        ))}
        <span className="ml-auto text-xs text-muted-foreground">double-click the board to add a note</span>
      </footer>
    </div>
  )
}

// ── doc: ordered text blocks ─────────────────────────────────────────────────────────────────────
// Block-keyed on purpose: id-keyed maps merge concurrent edits; WITHIN one block a string is
// last-writer-wins, so simultaneous typing in the same block clobbers — work in your own block.

function DocEditor({ docId }: { docId: string }): React.JSX.Element {
  const { data, update, delete: del } = useDoc('docs', docId)
  const patch = (p: DeepPartial<TextDoc>): void => update(p as Partial<TextDoc>)
  if (!data) return <PaneLoading />
  const blocks = Object.entries(data.blocks ?? {}).sort((a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1))

  const addBlock = (): void => {
    const order = (blocks.at(-1)?.[1].order ?? -1) + 1
    patch({ blocks: { [`b-${Math.random().toString(36).slice(2, 8)}`]: { order, text: '' } } })
  }
  const move = (i: number, dir: -1 | 1): void => {
    const a = blocks[i]
    const b = blocks[i + dir]
    if (!a || !b) return
    patch({ blocks: { [a[0]]: { order: b[1].order }, [b[0]]: { order: a[1].order } } })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-xl flex-col gap-1 px-4 py-4">
        {blocks.map(([id, b], i) => (
          <div key={id} className="group relative">
            <textarea
              value={b.text ?? ''}
              onChange={(e) => patch({ blocks: { [id]: { text: e.target.value } } })}
              placeholder="Write something…"
              rows={Math.max(2, (b.text ?? '').split('\n').length)}
              className="w-full resize-none rounded-md border border-transparent bg-transparent px-3 py-2 text-[15px] leading-relaxed hover:border-input focus:border-input focus:outline-none"
            />
            <div className="absolute -right-1 top-1 hidden gap-0.5 rounded-md border bg-background p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
              <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                <ArrowUp className="h-3.5 w-3.5" />
              </IconBtn>
              <IconBtn label="Move down" onClick={() => move(i, 1)} disabled={i === blocks.length - 1}>
                <ArrowDown className="h-3.5 w-3.5" />
              </IconBtn>
              <IconBtn label="Delete block" onClick={() => del(['blocks', id])}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconBtn>
            </div>
          </div>
        ))}
        <button type="button"
          onClick={addBlock}
          className="mt-1 flex items-center gap-1.5 self-start rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-4 w-4" /> Add block
        </button>
      </div>
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
    >
      {children}
    </button>
  )
}

function PaneLoading(): React.JSX.Element {
  return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">Opening…</div>
}
