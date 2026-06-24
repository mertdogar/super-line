import { useEffect, useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { memoryStoreClient } from '@super-line/store-memory'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chat } from '@/contract'
import { Provider } from '@/lib/superline'
import { Shell } from '@/components/shell'

const WS_URL = `ws://${location.hostname}:8790`

export function Workspace({
  name,
  onSignOut,
}: {
  name: string
  onSignOut: () => void
}): React.JSX.Element {
  // Create the client once; it connects immediately and reconnects on its own. The `chat` store's
  // client half is the in-memory LWW replica (pairs with store-sqlite's server half).
  const [client] = useState(() =>
    createSuperLineClient(chat, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: 'user',
      params: { name },
      stores: { chat: memoryStoreClient() },
    }),
  )
  useEffect(() => () => client.close(), [client])

  return (
    <Provider client={client}>
      <Shell me={name} onSignOut={onSignOut} />
    </Provider>
  )
}
