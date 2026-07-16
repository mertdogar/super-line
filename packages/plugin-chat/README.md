# @super-line/plugin-chat

A reusable **chat backbone** for [super-line](https://github.com/mertdogar/super-line), as a paired
plugin: channels (public + private), owner/member membership control, and messages (send · edit · delete),
all backed by typed collections. Every mutation is a **server-authoritative, hookable request**, and an
imperative server API lets agents and back-office code drive the same model as clients.

Requires [`@super-line/plugin-auth`](https://www.npmjs.com/package/@super-line/plugin-auth) — identity and
principals come from it, and chat rows reference its `users` directory.

```bash
pnpm add @super-line/plugin-chat @super-line/plugin-auth
```

```ts
// contract — merge both fragments
import { defineContract } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

export const app = defineContract({ roles: { user: {} }, plugins: [authContract(), chatContract()] })

// server — register the kit's plugin; wrap any operation with a hook
import { chat } from '@super-line/plugin-chat/server'
const chatKit = chat({ contract: app, hooks: { sendMessage: { after: (m) => notify(m) } } })

// client — typed requests + live stores (no React/TanStack dependency; agents use it too)
import { chatClient } from '@super-line/plugin-chat/client'
const chatCli = chatClient(client, { userId })
const ch = await chatCli.createChannel({ name: 'general', visibility: 'public' })
await chatCli.send(ch.id, 'hello')
```

Subpaths: `.` (contract fragment + schemas) · `/server` (`chat()` → `chatKit`) · `/client`
(`chatClient`) · `/react` (`createChatHooks`).

The message body is host-parametrized — `chatContract({ content })` — defaulting to plain text.

**Full guide:** <https://mertdogar.github.io/super-line/how-to/plugin-chat>
