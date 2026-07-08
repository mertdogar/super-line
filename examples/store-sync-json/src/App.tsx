import { useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { createSuperLineHooks } from '@super-line/react'
import { crdtCollectionsClient } from '@super-line/collections-crdt-memory'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { JsonEditor, type JsonValue } from '@visual-json/react'
import { api } from './contract.js'

const { Provider, useDoc, useRequest } = createSuperLineHooks<typeof api, 'user'>()

const WS_URL = `ws://${location.hostname}:8795`
const DOC = 'plan'

// A name identifies you to the server (the ACL principal). `?name=ada` or a random one.
function pickName(): string {
  const fromUrl = new URL(location.href).searchParams.get('name')?.trim()
  return fromUrl || `user-${Math.random().toString(36).slice(2, 6)}`
}

function Editor() {
  // useDoc catches up to the server snapshot, stays live (remote merges), and gives set().
  const { data, set } = useDoc('docs', DOC)
  const { call: nudge, isLoading } = useRequest('nudge')

  if (data === undefined) return <p className="muted">connecting…</p>

  return (
    <>
      <div className="bar">
        <button onClick={() => void nudge()} disabled={isLoading}>
          Server nudge
        </button>
        <span className="muted">edit any field — it merges live across tabs</span>
      </div>
      {/* JsonEditor is the editable all-in-one: controlled value/onChange. onChange hands back the full
          new value → doc.set → super-store CRDT diff → fan-out to the other tabs. */}
      <JsonEditor value={data as JsonValue} onChange={(v) => set(v as Record<string, unknown>)} height={420} />
    </>
  )
}

export function App() {
  const [name] = useState(pickName)
  const [client] = useState(() =>
    createSuperLineClient(api, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: 'user',
      params: { name },
      // the universal CRDT client engine — pairs with any CRDT collection backend
      crdtCollections: crdtCollectionsClient(),
    }),
  )

  return (
    <Provider client={client}>
      <h1>store-sync · JSON</h1>
      <p className="muted">
        You are <b>{name}</b>. Open this page in a second tab (or <code>?name=bob</code>) and edit the JSON —
        changes merge live, and concurrent edits to different fields both survive.
      </p>
      <Editor />
    </Provider>
  )
}
