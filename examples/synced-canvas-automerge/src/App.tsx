import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { createSuperLineHooks } from '@super-line/react'
import * as A from '@automerge/automerge'
import { canvas } from './contract.js'
import { fromB64 } from './b64.js'
import {
  addShape,
  bringToFront,
  deleteShape,
  formatPatch,
  moveShape,
  readShapes,
  type Canvas,
  type Doc,
  type PatchEntry,
  type Shape,
} from './crdt.js'

const WS_URL = 'ws://localhost:8790'
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
  useEffect(() => () => client.close(), [client])

  return (
    <Provider client={client}>
      <Board me={name} />
    </Provider>
  )
}

function Board({ me }: { me: string }) {
  // Automerge docs are immutable: every edit/merge returns a NEW doc. We keep the live doc
  // in a ref (so rapid drags always branch off the latest, not a stale render closure) and
  // force a re-render. The Yjs example needed none of this — its single mutable Y.Doc +
  // observer handled it for free. This is the immutable-doc DX cost, made concrete.
  const docRef = useRef<Doc>(A.init<Canvas>())
  const [, setTick] = useState(0)
  const rerender = (): void => setTick((t) => t + 1)
  const [ready, setReady] = useState(false)
  const boardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  // Debug patch log (capped, newest first). Unlike Yjs's passive `observeDeep`, Automerge
  // hands you patches only at the change/merge call sites — so we capture them here.
  const [patchLog, setPatchLog] = useState<PatchEntry[]>([])
  const patchId = useRef(0)
  const logPatches = (origin: string, patches: A.Patch[]): void => {
    if (patches.length === 0) return
    patchId.current += 1
    const entry: PatchEntry = { id: patchId.current, origin, at: Date.now(), patches }
    setPatchLog((prev) => [entry, ...prev].slice(0, 50))
  }

  const { call: joinDoc } = useRequest('joinDoc')
  const { call: pushChange } = useRequest('pushChange')
  const { call: serverNudge } = useRequest('serverNudge')

  // Catch up by LOADING the server's snapshot — never `A.from` on the client (that forks
  // history). `load` doesn't go through patchCallback, so the patch log starts empty.
  useEffect(() => {
    void joinDoc({ docId: DOC_ID })
      .then(({ snapshot }) => {
        docRef.current = A.load<Canvas>(fromB64(snapshot))
        setReady(true)
        rerender()
      })
      .catch(() => {})
  }, [joinDoc])

  // Apply change(s) the server fans out, tagged by origin ('peer' = another client, 'server').
  useEvent('change', (msg) => {
    if (msg.docId !== DOC_ID) return
    let captured: A.Patch[] = []
    const [next] = A.applyChanges(docRef.current, msg.changes.map(fromB64), {
      patchCallback: (p: A.Patch[]) => (captured = p),
    })
    docRef.current = next
    logPatches(msg.origin, captured)
    rerender()
  })

  // Apply a local edit: swap in the new doc, log + push its change(s), re-render.
  const apply = ([next, changes, patches]: [Doc, string[], A.Patch[]]): void => {
    docRef.current = next
    logPatches('local', patches)
    rerender()
    if (changes.length) void pushChange({ docId: DOC_ID, changes }).catch(() => {})
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, s: Shape): void => {
    apply(bringToFront(docRef.current, s.id))
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
    apply(moveShape(docRef.current, d.id, x, y))
  }

  const onPointerUp = (): void => {
    drag.current = null
  }

  const shapes = readShapes(docRef.current)

  return (
    <div className="wrap">
      <header>
        <strong>synced canvas · automerge</strong>
        <span>
          you are <b>{me}</b> · {shapes.length} shapes{ready ? '' : ' · connecting…'}
        </span>
        <div className="actions">
          <button type="button" disabled={!ready} onClick={() => apply(addShape(docRef.current))}>
            Add shape
          </button>
          <button type="button" disabled={!ready} onClick={() => void serverNudge({ docId: DOC_ID }).catch(() => {})}>
            Server nudge
          </button>
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
              onDoubleClick={() => apply(deleteShape(docRef.current, s.id))}
              title="drag to move · double-click to delete"
            >
              {s.label}
            </div>
          ))}
        </div>
        <DebugPanel state={docRef.current} patches={patchLog} />
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
              <code>{p.patches.map(formatPatch).join('\n')}</code>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
