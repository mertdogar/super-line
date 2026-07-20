import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createSuperLineHooks } from '@super-line/react'
import * as Y from 'yjs'
import { canvas } from './contract.js'
import { fromB64, toB64 } from './b64.js'
import {
  addShape,
  bringToFront,
  deleteShape,
  formatChange,
  moveShape,
  readState,
  usePatchLog,
  useShapes,
  type PatchEntry,
  type Shape,
} from './crdt.js'

const WS_URL = 'ws://localhost:8788'
const DOC_ID = 'board'

const { Provider, useRequest, useEvent } = createSuperLineHooks<typeof canvas, 'user'>()

export function App() {
  const [name] = useState(() => `user-${Math.random().toString(36).slice(2, 6)}`)
  const [client] = useState(() =>
    createSuperLineClient(canvas, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: 'user',
      params: { name },
    }),
  )
  const [doc] = useState(() => new Y.Doc())
  useEffect(() => () => client.close(), [client])

  return (
    <Provider client={client}>
      <Board doc={doc} me={name} />
    </Provider>
  )
}

function Board({ doc, me }: { doc: Y.Doc; me: string }) {
  const shapes = useShapes(doc)
  const patches = usePatchLog(doc)
  const { call: joinDoc } = useRequest('joinDoc')
  const { call: pushUpdate } = useRequest('pushUpdate')
  const { call: serverNudge } = useRequest('serverNudge')
  const boardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  // Wire the local Y.Doc to the bus: push local edits up, apply remote merges down.
  useEffect(() => {
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      // Only push edits made locally — applied-remote updates carry a 'peer'/'server'/'sync'
      // origin and must not be echoed back up.
      if (origin !== 'local') return
      void pushUpdate({ docId: DOC_ID, update: toB64(update) }).catch(() => {})
    }
    doc.on('update', onUpdate)
    // Catch up to the server's current state on mount; 'sync' keeps it out of the patch log.
    void joinDoc({ docId: DOC_ID })
      .then(({ snapshot }) => Y.applyUpdate(doc, fromB64(snapshot), 'sync'))
      .catch(() => {})
    return () => doc.off('update', onUpdate)
  }, [doc, joinDoc, pushUpdate])

  // Apply updates the server fans out, tagged by origin (other clients = 'peer', server = 'server').
  useEvent('update', (msg) => {
    if (msg.docId !== DOC_ID) return
    Y.applyUpdate(doc, fromB64(msg.update), msg.origin)
  })

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, s: Shape): void => {
    bringToFront(doc, s.id)
    const rect = boardRef.current?.getBoundingClientRect()
    drag.current = {
      id: s.id,
      dx: e.clientX - (rect?.left ?? 0) - s.x,
      dy: e.clientY - (rect?.top ?? 0) - s.y,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const rect = boardRef.current?.getBoundingClientRect()
    const x = Math.max(0, Math.round(e.clientX - (rect?.left ?? 0) - d.dx))
    const y = Math.max(0, Math.round(e.clientY - (rect?.top ?? 0) - d.dy))
    moveShape(doc, d.id, x, y)
  }

  const onPointerUp = (): void => {
    drag.current = null
  }

  return (
    <div className="wrap">
      <header>
        <strong>synced canvas · yjs</strong>
        <span>
          you are <b>{me}</b> · {shapes.length} shapes
        </span>
        <div className="actions">
          <button type="button" onClick={() => addShape(doc)}>Add shape</button>
          <button type="button" onClick={() => void serverNudge({ docId: DOC_ID }).catch(() => {})}>Server nudge</button>
        </div>
      </header>
      <div className="main">
        <div className="board" ref={boardRef}>
          {shapes.map((s) => (
            <div
              key={s.id}
              className="shape"
              style={{ left: s.x, top: s.y, background: s.color, zIndex: s.order }}
              onPointerDown={(e) => onPointerDown(e, s)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={() => deleteShape(doc, s.id)}
              title="drag to move · double-click to delete"
            >
              {s.label}
            </div>
          ))}
        </div>
        <DebugPanel state={readState(doc)} patches={patches} />
      </div>
      <footer>
        Open this page in two windows. Drag shapes, “Add shape”, hit “Server nudge”. State persists on the
        server across reloads.
      </footer>
    </div>
  )
}

// Read-only debug side panel: a live JSON mirror of the synced state + a capped log of the
// most recent decoded patches, each tagged by origin (local / peer / server).
function DebugPanel({ state, patches }: { state: unknown; patches: PatchEntry[] }) {
  return (
    <aside className="panel">
      <section className="panel-state">
        <h2>state</h2>
        <pre>{JSON.stringify(state, null, 2)}</pre>
      </section>
      <section className="panel-patches">
        <h2>
          patches <span className="muted">· {patches.length}</span>
        </h2>
        <ul>
          {patches.map((p, i) => (
            <li key={p.id} className={i === 0 ? 'latest' : undefined}>
              <span className={`origin origin-${p.origin}`}>{p.origin}</span>
              <code>{p.changes.map(formatChange).join('\n')}</code>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
