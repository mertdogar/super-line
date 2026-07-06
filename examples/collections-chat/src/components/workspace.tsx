import { useEffect, useMemo, useState } from 'react'
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { chat } from '@/contract'
import { Provider } from '@/lib/superline'
import { ChatProvider } from '@/lib/chat'
import { slug } from '@/lib/identity'
import { Shell } from '@/components/shell'

const WS_URL = `ws://${location.hostname}:8791`

export function Workspace({
  name,
  onSignOut,
}: {
  name: string
  onSignOut: () => void
}): React.JSX.Element {
  // Create the client once; it connects immediately and reconnects on its own. No store client half —
  // durable state is TanStack DB collections synced by super-line (see lib/chat.tsx).
  const [client] = useState(() =>
    createSuperLineClient(chat, {
      transport: webSocketClientTransport({ url: WS_URL }),
      role: 'user',
      params: { name },
    }),
  )
  useEffect(() => () => client.close(), [client])

  // my user id — the principal the server's row policies check
  const me = useMemo(() => slug(name), [name])

  return (
    <Provider client={client}>
      <ChatProvider me={me}>
        <Shell myName={name} onSignOut={onSignOut} />
      </ChatProvider>
    </Provider>
  )
}
