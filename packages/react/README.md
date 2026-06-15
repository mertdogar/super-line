# @super-line/react

React hooks for [**super-line**](https://mertdogar.github.io/super-line/) — typed `useRequest` / `useEvent` / `useSubscription` bound to a contract + role.

```bash
pnpm add @super-line/react
```

```tsx
import { useState } from 'react'
import { createClient } from '@super-line/client'
import { createSocketReact } from '@super-line/react'
import { api } from './contract'

const { Provider, useRequest, useEvent, useSubscription } = createSocketReact<typeof api, 'user'>()

function Root() {
  const [client] = useState(() => createClient(api, { url: 'ws://localhost:3000', role: 'user' }))
  return <Provider client={client}><Room /></Provider>
}

function Room() {
  const { call: send, isLoading } = useRequest('send')
  const presence = useSubscription('presence')
  useEvent('message', (m) => append(m))
  // ...
}
```

`react >= 18` is a peer dependency. Every hook is narrowed to the role passed to `createSocketReact<typeof api, 'user'>()`.

- 📖 Docs: <https://mertdogar.github.io/super-line/>
- 📚 Guide: [React](https://mertdogar.github.io/super-line/guide/react)
- 📕 API reference: <https://mertdogar.github.io/super-line/reference/>
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
