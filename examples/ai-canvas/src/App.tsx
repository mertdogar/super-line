import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { createSuperLineHooks } from '@super-line/react'
import { syncStoreClient } from '@super-line/store-sync'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { api } from './contract.js'
import { COLORS, newShapeId, readShapes, resolveOptions, SCENE_ID, topOrder, type Scene, type ScenePatch } from './scene.js'

const { Provider, useResource, useRequest } = createSuperLineHooks<typeof api, 'user'>()

// Connect back to the host the page was served from, so it works over Tailscale / LAN, not just localhost.
const WS_URL = `ws://${location.hostname}:8796`

function pickName(): string {
  const fromUrl = new URL(location.href).searchParams.get('name')?.trim()
  return fromUrl || `user-${Math.random().toString(36).slice(2, 6)}`
}

export function App() {
  const [name] = useState(pickName)
  const [client] = useState(() =>
    createSuperLineClient(api, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: 'user',
      params: { name },
      stores: { scene: syncStoreClient({ resolveOptions }) },
    }),
  )
  return (
    <Provider client={client}>
      <Board me={name} />
    </Provider>
  )
}

interface LogEntry {
  id: number
  prompt: string
  lines: string[]
  kind: 'agent' | 'error'
}

function Board({ me }: { me: string }) {
  const { data, update, delete: del } = useResource<Scene>('scene', SCENE_ID)
  const { call: agentEdit, isLoading } = useRequest('agentEdit')
  const [prompt, setPrompt] = useState('')
  const [log, setLog] = useState<LogEntry[]>([])
  const boardRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const logId = useRef(0)

  // One merge write. The Store merges deeply (document mode), so a partial shape is fine at runtime;
  // the cast just relaxes the per-field type for these surgical writes.
  const patch = (p: ScenePatch): void => update(p as Parameters<typeof update>[0])

  const shapes = readShapes(data)

  const onAdd = (): void => {
    const id = newShapeId()
    const color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#888'
    patch({
      shapes: {
        [id]: { x: Math.round(Math.random() * 340), y: Math.round(Math.random() * 320), color, label: id.slice(2), order: topOrder(data) },
      },
    })
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string, x: number, y: number): void => {
    patch({ shapes: { [id]: { order: topOrder(data) } } }) // bring to front
    const rect = boardRef.current?.getBoundingClientRect()
    drag.current = { id, dx: e.clientX - (rect?.left ?? 0) - x, dy: e.clientY - (rect?.top ?? 0) - y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const rect = boardRef.current?.getBoundingClientRect()
    const x = Math.max(0, Math.round(e.clientX - (rect?.left ?? 0) - d.dx))
    const y = Math.max(0, Math.round(e.clientY - (rect?.top ?? 0) - d.dy))
    patch({ shapes: { [d.id]: { x, y } } })
  }

  const onPointerUp = (): void => {
    drag.current = null
  }

  const runAgent = async (): Promise<void> => {
    const p = prompt.trim()
    if (!p || isLoading) return
    setPrompt('')
    try {
      const res = await agentEdit({ prompt: p })
      const lines = res.actions.map((a) => `· ${a.tool} ${a.detail}`)
      setLog((prev) => [{ id: ++logId.current, prompt: p, lines: lines.length ? lines : [res.summary], kind: 'agent' as const }, ...prev].slice(0, 30))
    } catch (err) {
      setLog((prev) => [{ id: ++logId.current, prompt: p, lines: [(err as Error).message], kind: 'error' as const }, ...prev].slice(0, 30))
    }
  }

  if (data === undefined) return <p className="connecting">connecting…</p>

  return (
    <div className="wrap">
      <header>
        <strong>ai-canvas</strong>
        <span>
          you are <b>{me}</b> · {shapes.length} shapes
        </span>
        <div className="actions">
          <button onClick={onAdd}>Add shape</button>
        </div>
      </header>

      <div className="agentbar">
        <input
          value={prompt}
          placeholder='ask the agent — e.g. "add three blue circles in a row, then delete the red one"'
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runAgent()
          }}
          disabled={isLoading}
        />
        <button onClick={() => void runAgent()} disabled={isLoading || !prompt.trim()}>
          {isLoading ? 'thinking…' : 'Send'}
        </button>
      </div>

      <div className="main">
        <div className="board" ref={boardRef}>
          {shapes.map((s) => (
            <div
              key={s.id}
              className="shape"
              style={{ left: s.x, top: s.y, background: s.color, zIndex: s.order }}
              onPointerDown={(e) => onPointerDown(e, s.id, s.x, s.y)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={() => del(['shapes', s.id])}
              title="drag to move · double-click to delete"
            >
              {s.label}
            </div>
          ))}
        </div>

        <aside className="panel">
          <section className="panel-log">
            <h2>agent activity</h2>
            {log.length === 0 ? (
              <p className="muted">ask the agent above — its edits land on the board (and in every tab).</p>
            ) : (
              <ul>
                {log.map((e, i) => (
                  <li key={e.id} className={i === 0 ? 'latest' : undefined}>
                    <span className={`tag tag-${e.kind}`}>{e.kind === 'error' ? 'error' : 'agent'}</span>
                    <code>
                      {`▸ ${e.prompt}\n`}
                      {e.lines.join('\n')}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel-state">
            <h2>scene state</h2>
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </section>
        </aside>
      </div>

      <footer>
        Open this page in two windows (try <code>?name=ada</code>). Drag shapes, double-click to delete, and ask the
        agent to edit — its writes merge into the same board live, even while you drag.
      </footer>
    </div>
  )
}
