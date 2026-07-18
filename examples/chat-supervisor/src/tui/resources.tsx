// The resource pane: Canvas | Doc tabs over the channel's live CRDT documents. The human edits the
// same docs the editor subagent writes — canvas notes as absolutely-positioned colored boxes scaled
// from web coords (mouse click-select + drag-move, arrow-key nudge in move mode), the doc as an
// ordered block list (pick / reorder / edit / add / remove). Presence is the coarse who's-open line.
//
// Registry + presence come from the library hooks (hooks.ts). Only the doc hook stays local:
// `useDoc` from @super-line/react always opens, but the pane's docIds arrive async from the registry
// — `useCrdtDoc` tolerates an empty id instead of forcing a mount-gate per tab.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import type { KeyEvent, MouseEvent } from '@opentui/core'
import type { DocHandle, SuperLineClient } from '@super-line/client'
import { COLORS } from './theme'
import { Dialog } from './dialog'
import { TextEditor } from './pickers'
import { useChannelResources, useResourcePresence } from './hooks'
import type { app, CanvasDoc, TextDoc } from '../contract'

type Client = SuperLineClient<typeof app, 'user'>

// The web canvas board is 1200×800 (see agents.ts RESOURCE_SHAPES); notes carry hex `color`s.
export const WEB_W = 1200
export const WEB_H = 800
export const NOTE_W = 18
export const NOTE_H = 4
const PALETTE = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8'] // the web new-note swatches

// DocHandle.update's TYPE is a shallow Partial<Doc>, but document-mode docs deep-merge nested
// partials — that's what keeps a nudged x/y from clobbering concurrently-edited text (same widening
// the web resources.tsx does). One honest cast per editor instead of full-object writes that clobber.
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const newId = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 8)}`
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

interface DocState<T> {
  data: T | undefined
  update: (partial: DeepPartial<T>) => void
  del: (path: (string | number)[]) => void
}

function useCrdtDoc<T>(client: Client, name: 'canvases' | 'docs', id: string): DocState<T> {
  const [data, setData] = useState<T>()
  const ref = useRef<DocHandle<T>>(undefined)
  useEffect(() => {
    if (!id) {
      setData(undefined)
      ref.current = undefined
      return
    }
    const handle = client.collection(name).open(id) as unknown as DocHandle<T>
    ref.current = handle
    setData(handle.getSnapshot())
    const unsub = handle.subscribe(() => setData(handle.getSnapshot()))
    return () => {
      unsub()
      handle.close()
      ref.current = undefined
    }
  }, [client, name, id])
  const update = useCallback((partial: DeepPartial<T>) => ref.current?.update(partial as Partial<T>), [])
  const del = useCallback((path: (string | number)[]) => ref.current?.delete(path), [])
  return { data, update, del }
}

// ── canvas ─────────────────────────────────────────────────────────────────────────────────────────

type Note = { x: number; y: number; color: string; text: string }

export function scaleNote(x: number, y: number, innerW: number, innerH: number): { left: number; top: number } {
  return {
    left: Math.round((x / WEB_W) * Math.max(0, innerW - NOTE_W)),
    top: Math.round((y / WEB_H) * Math.max(0, innerH - NOTE_H)),
  }
}

export function unscaleNote(left: number, top: number, innerW: number, innerH: number): { x: number; y: number } {
  return {
    x: clamp(Math.round((left / Math.max(1, innerW - NOTE_W)) * WEB_W), 0, WEB_W),
    y: clamp(Math.round((top / Math.max(1, innerH - NOTE_H)) * WEB_H), 0, WEB_H),
  }
}

function NoteBox({
  id,
  note,
  selected,
  innerW,
  innerH,
  onSelect,
  onMove,
}: {
  id: string
  note: Note
  selected: boolean
  innerW: number
  innerH: number
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
}) {
  const { left, top } = scaleNote(note.x, note.y, innerW, innerH)
  const grab = useRef<{ dx: number; dy: number } | null>(null)
  const drag = (e: MouseEvent) => {
    if (!grab.current) return
    const { x, y } = unscaleNote(e.x - grab.current.dx, e.y - grab.current.dy, innerW, innerH)
    onMove(id, x, y)
  }
  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={NOTE_W}
      height={NOTE_H}
      zIndex={selected ? 10 : 1}
      border
      borderStyle={selected ? 'heavy' : 'single'}
      borderColor={selected ? COLORS.accent : note.color}
      backgroundColor={note.color}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={(e: MouseEvent) => {
        onSelect(id)
        grab.current = { dx: e.x - left, dy: e.y - top }
      }}
      onMouseDrag={drag}
      onMouseDrop={(e: MouseEvent) => {
        drag(e)
        grab.current = null
      }}
    >
      <text fg={COLORS.panel}>{(note.text ?? '').slice(0, (NOTE_W - 4) * 2)}</text>
    </box>
  )
}

function CanvasView({
  canvas,
  selectedId,
  innerW,
  innerH,
  onSelect,
  onMove,
}: {
  canvas: CanvasDoc
  selectedId: string | null
  innerW: number
  innerH: number
  onSelect: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
}) {
  const items = Object.entries(canvas.items ?? {})
  return (
    <box flexGrow={1} border borderStyle="single" borderColor={COLORS.border} title={` ${canvas.title} `}>
      {items.length === 0 ? (
        <box paddingLeft={1} paddingTop={1}>
          <text fg={COLORS.dim}>{'empty — n new note, or ask the supervisor to fill it'}</text>
        </box>
      ) : null}
      {items.map(([id, note]) => (
        <NoteBox
          key={id}
          id={id}
          note={note}
          selected={id === selectedId}
          innerW={innerW}
          innerH={innerH}
          onSelect={onSelect}
          onMove={onMove}
        />
      ))}
    </box>
  )
}

// ── doc ──────────────────────────────────────────────────────────────────────────────────────────

function DocView({
  doc,
  blocks,
  selectedId,
}: {
  doc: TextDoc
  blocks: [string, { order: number; text: string }][]
  selectedId: string | null
}) {
  return (
    <box
      flexGrow={1}
      border
      borderStyle="single"
      borderColor={COLORS.border}
      title={` ${doc.title} `}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {blocks.length === 0 ? <text fg={COLORS.dim}>{'empty — n new block'}</text> : null}
      {blocks.map(([id, block]) => {
        const active = id === selectedId
        return (
          <box
            key={id}
            flexDirection="row"
            gap={1}
            backgroundColor={active ? COLORS.rowActive : undefined}
            paddingBottom={1}
          >
            <text fg={active ? COLORS.accent : COLORS.dim}>{active ? '▸' : ' '}</text>
            <text fg={active ? COLORS.text : COLORS.dim} flexGrow={1}>
              {block.text || '·'}
            </text>
          </box>
        )
      })}
    </box>
  )
}

// ── presence ─────────────────────────────────────────────────────────────────────────────────────

function PresenceLine({
  row,
  me,
  names,
}: {
  row: { kind: string; collection: string; docId: string }
  me: string
  names: Map<string, string>
}) {
  const present = useResourcePresence(row)
  return (
    <box flexDirection="row" gap={1} paddingLeft={1}>
      {present.length === 0 ? <text fg={COLORS.dim}>◌ no viewers</text> : null}
      {present.map((p) => {
        const name = names.get(p.userId) ?? 'someone'
        const bot = name === 'Supervisor'
        return (
          <text key={p.userId} fg={bot ? COLORS.purple : p.userId === me ? COLORS.accent : COLORS.green}>
            {`◉ ${p.userId === me ? 'you' : name}`}
          </text>
        )
      })}
    </box>
  )
}

// ── pane ─────────────────────────────────────────────────────────────────────────────────────────

type EditTarget =
  | { type: 'note'; id: string }
  | { type: 'new-note' }
  | { type: 'block'; id: string }
  | { type: 'new-block' }

export function ResourcePane({
  client,
  channelId,
  tab,
  focused,
  width,
  height,
  me,
  names,
  onSetTab,
  onReturnToPrompt,
}: {
  client: Client
  channelId: string
  tab: 'canvas' | 'doc'
  focused: boolean
  width: number
  height: number
  me: string
  names: Map<string, string>
  onSetTab: (t: 'canvas' | 'doc') => void
  onReturnToPrompt: () => void
}) {
  const rows = useChannelResources(channelId)
  const canvasRow = rows.find((r) => r.kind === 'canvas')
  const docRow = rows.find((r) => r.kind === 'doc')
  const canvas = useCrdtDoc<CanvasDoc>(client, 'canvases', canvasRow?.docId ?? '')
  const doc = useCrdtDoc<TextDoc>(client, 'docs', docRow?.docId ?? '')

  const [selectedNote, setSelectedNote] = useState<string | null>(null)
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null)
  const [moveMode, setMoveMode] = useState(false)
  const [edit, setEdit] = useState<EditTarget | null>(null)

  const innerW = Math.max(1, width - 4)
  const innerH = Math.max(1, height - 6)
  const cellX = Math.max(1, Math.round(WEB_W / Math.max(1, innerW - NOTE_W)))
  const cellY = Math.max(1, Math.round(WEB_H / Math.max(1, innerH - NOTE_H)))

  const items = useMemo(() => Object.keys(canvas.data?.items ?? {}), [canvas.data])
  const blocks = useMemo(
    () =>
      Object.entries(doc.data?.blocks ?? {}).sort((a, b) => a[1].order - b[1].order || (a[0] < b[0] ? -1 : 1)),
    [doc.data],
  )
  const activeRow = tab === 'canvas' ? canvasRow : docRow

  // Drop a stale selection when a concurrent delete removes the target (never resurrect it).
  useEffect(() => {
    if (selectedNote && !items.includes(selectedNote)) setSelectedNote(null)
  }, [items, selectedNote])
  useEffect(() => {
    if (selectedBlock && !blocks.some(([id]) => id === selectedBlock)) setSelectedBlock(null)
  }, [blocks, selectedBlock])

  const patchNote = (id: string, p: DeepPartial<Note>) => {
    if (id in (canvas.data?.items ?? {})) canvas.update({ items: { [id]: p } })
  }
  const nudge = (dx: number, dy: number) => {
    if (!selectedNote) return
    const it = canvas.data?.items?.[selectedNote]
    if (!it) return
    patchNote(selectedNote, { x: clamp(it.x + dx, 0, WEB_W), y: clamp(it.y + dy, 0, WEB_H) })
  }

  const editInitial = (t: EditTarget): string =>
    t.type === 'note'
      ? (canvas.data?.items?.[t.id]?.text ?? '')
      : t.type === 'block'
        ? (blocks.find(([id]) => id === t.id)?.[1].text ?? '')
        : ''

  // Concurrent-edit contract: the dialog holds its OWN draft (TextEditor's uncontrolled textarea),
  // so an agent/CRDT update landing mid-edit re-renders the board behind the modal without touching
  // the draft. On save we write ONLY the edited field via deep-merge, so a concurrent move/other-field
  // edit survives; if the target was deleted mid-edit the write is dropped (the `in`/`some` guard).
  const saveEdit = (text: string) => {
    const target = edit
    setEdit(null)
    if (!target) return
    const value = text.trim()
    if (target.type === 'note') {
      if (target.id in (canvas.data?.items ?? {})) canvas.update({ items: { [target.id]: { text: value } } })
    } else if (target.type === 'new-note') {
      if (!value) return
      const id = newId('n')
      canvas.update({
        items: { [id]: { x: Math.round(WEB_W / 2), y: Math.round(WEB_H / 2), color: PALETTE[0]!, text: value } },
      })
      setSelectedNote(id)
    } else if (target.type === 'block') {
      if (blocks.some(([id]) => id === target.id)) doc.update({ blocks: { [target.id]: { text: value } } })
    } else {
      if (!value) return
      const id = newId('b')
      const order = (blocks.at(-1)?.[1].order ?? -1) + 1
      doc.update({ blocks: { [id]: { order, text: value } } })
      setSelectedBlock(id)
    }
  }

  const canvasKey = (key: KeyEvent) => {
    const idx = selectedNote ? items.indexOf(selectedNote) : -1
    if (key.name === 'left' || key.name === 'up') {
      if (items.length) setSelectedNote(items[(Math.max(0, idx) - 1 + items.length) % items.length]!)
    } else if (key.name === 'right' || key.name === 'down') {
      if (items.length) setSelectedNote(items[(idx + 1) % items.length]!)
    } else if (key.name === 'm' && selectedNote) {
      setMoveMode(true)
    } else if (key.name === 'e' && selectedNote) {
      setEdit({ type: 'note', id: selectedNote })
    } else if (key.name === 'n') {
      setEdit({ type: 'new-note' })
    } else if (key.name === 'x' && selectedNote) {
      canvas.del(['items', selectedNote])
      setSelectedNote(null)
    }
  }

  const docKey = (key: KeyEvent) => {
    const idx = selectedBlock ? blocks.findIndex(([id]) => id === selectedBlock) : -1
    if (key.shift && (key.name === 'up' || key.name === 'down')) {
      const dir = key.name === 'up' ? -1 : 1
      const a = blocks[idx]
      const b = blocks[idx + dir]
      if (a && b) doc.update({ blocks: { [a[0]]: { order: b[1].order }, [b[0]]: { order: a[1].order } } })
    } else if (key.name === 'up' || key.name === 'k') {
      if (blocks.length) setSelectedBlock(blocks[(Math.max(0, idx) - 1 + blocks.length) % blocks.length]![0])
    } else if (key.name === 'down' || key.name === 'j') {
      if (blocks.length) setSelectedBlock(blocks[(idx + 1) % blocks.length]![0])
    } else if (key.name === 'e' && selectedBlock) {
      setEdit({ type: 'block', id: selectedBlock })
    } else if (key.name === 'n') {
      setEdit({ type: 'new-block' })
    } else if (key.name === 'x' && selectedBlock) {
      doc.del(['blocks', selectedBlock])
      setSelectedBlock(null)
    }
  }

  useKeyboard((key) => {
    if (!focused || edit || key.eventType !== 'press') return
    if (moveMode) {
      if (key.name === 'left') nudge(-cellX, 0)
      else if (key.name === 'right') nudge(cellX, 0)
      else if (key.name === 'up') nudge(0, -cellY)
      else if (key.name === 'down') nudge(0, cellY)
      else if (key.name === 'return' || key.name === 'escape') setMoveMode(false)
      return
    }
    if (key.name === 'escape' || key.name === 'tab') onReturnToPrompt()
    else if (key.name === '1') onSetTab('canvas')
    else if (key.name === '2') onSetTab('doc')
    else if (tab === 'canvas') canvasKey(key)
    else docKey(key)
  })

  const hints = !focused
    ? '⇥ focus pane'
    : moveMode
      ? '←→↑↓ nudge · ⏎/esc done'
      : tab === 'canvas'
        ? '←→ pick · m move · e edit · n new · x del'
        : '↑↓ pick · ⇧↑↓ reorder · e edit · n new · x del'

  const body = tab === 'canvas' ? canvas : doc

  return (
    <box
      width={width}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={focused ? COLORS.accent : COLORS.border}
      title=" resources "
    >
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <box backgroundColor={tab === 'canvas' ? COLORS.rowActive : undefined}>
          <text fg={tab === 'canvas' ? COLORS.accent : COLORS.dim}>{' 1 Canvas '}</text>
        </box>
        <box backgroundColor={tab === 'doc' ? COLORS.rowActive : undefined}>
          <text fg={tab === 'doc' ? COLORS.accent : COLORS.dim}>{' 2 Doc '}</text>
        </box>
      </box>
      <box flexGrow={1} flexDirection="column">
        {!activeRow ? (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={COLORS.dim}>Setting up this channel's canvas and doc…</text>
          </box>
        ) : !body.data ? (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={COLORS.dim}>Opening…</text>
          </box>
        ) : tab === 'canvas' ? (
          <CanvasView
            canvas={canvas.data!}
            selectedId={selectedNote}
            innerW={innerW}
            innerH={innerH}
            onSelect={setSelectedNote}
            onMove={(id, x, y) => patchNote(id, { x, y })}
          />
        ) : (
          <DocView doc={doc.data!} blocks={blocks} selectedId={selectedBlock} />
        )}
      </box>
      {activeRow ? (
        <PresenceLine
          key={activeRow.docId}
          row={{ kind: activeRow.kind, collection: activeRow.collection, docId: activeRow.docId }}
          me={me}
          names={names}
        />
      ) : null}
      <box paddingLeft={1}>
        <text fg={COLORS.dim}>{hints}</text>
      </box>
      {edit ? (
        <Dialog title={edit.type.startsWith('new') ? 'New' : 'Edit'}>
          <TextEditor initial={editInitial(edit)} onSave={saveEdit} onClose={() => setEdit(null)} />
        </Dialog>
      ) : null}
    </box>
  )
}
