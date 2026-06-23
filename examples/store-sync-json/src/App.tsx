import { useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { createSuperLineHooks } from '@super-line/react'
import { syncStoreClient } from '@super-line/store-sync'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { JsonEditor, type JsonValue } from '@visual-json/react'
import { api } from './contract.js'

const { Provider, useResource, useRequest } = createSuperLineHooks<typeof api, 'user'>()

const WS_URL = `ws://${location.hostname}:8795`
const DOC = 'plan'

// A name identifies you to the server (the ACL principal). `?name=ada` or a random one.
function pickName(): string {
  const fromUrl = new URL(location.href).searchParams.get('name')?.trim()
  return fromUrl || `user-${Math.random().toString(36).slice(2, 6)}`
}

function Editor() {
  // useResource catches up to the server snapshot, stays live (remote merges), and gives set().
  const { data, set } = useResource<JsonValue>('docs', DOC)
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
          new value → store.set → super-store CRDT diff → fan-out to the other tabs. */}
      <JsonEditor value={data} onChange={set} height={420} />
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
      // the CRDT client half — pairs with syncStoreServer() on the server
      stores: { docs: syncStoreClient() },
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
