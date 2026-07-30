<script setup>
import AuthChatDemo from '../.vitepress/theme/components/demos/AuthChatDemo.vue'
</script>

# Tutorial 5 · Add auth + chat — plugins snap in whole domains

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/store-your-data">4 · Store your data</a> → <strong>5 · Add auth + chat</strong> → <a href="/tutorials/collaborate-with-crdt">6 · Collaborate on one document</a></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
In <a href="/tutorials/store-your-data">Tutorial 4</a> you faked identity with a handshake param and hand-wrote one policy. Real apps need sign-up, sessions, roles — and a real chat model is channels, membership, and per-channel security on top. Both ship as <strong>plugins</strong>: contract fragments that merge into <em>your</em> contract, paired with server kits that bring their own policies and handlers. You wire touch-points; you write <strong>no</strong> auth tables and <strong>no</strong> chat handlers.
</p>

<p class="sl-qs-meta">
  <span>~10 minutes</span>
  <span>Builds on Tutorial 4</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Merge</b> two <code>plugins</code></span>
  <span class="sl-qs-pill"><b>Sign up</b> <code>authClient</code></span>
  <span class="sl-qs-pill"><b>Chat</b> <code>chatClient</code></span>
</p>

</div>

## First, see it run

This form is not a mock. Submitting it runs **`@super-line/plugin-auth`'s actual sign-up path in this tab** — scrypt-hashes the password, creates the user, mints a session, and swaps the guest connection for an authed one (watch the state strip). Then you're chatting in a real `plugin-chat` channel as that user. Grace is a seeded user; her replies are scripted, but they travel through the real server-side `chatKit` — the same trusted door an AI agent uses.

<AuthChatDemo />

Sign out and watch the surface go idle — every identity change in super-line is a **session replacement**: the role is fixed at connect, so changing who you are means swapping the connection. The plugins own that dance; you never write it.

## 1. Install the two plugins

Chat **requires** auth on the same server — its rows reference the `users` directory and every action is keyed on the signed-in principal. You have everything else from Tutorials 1–4.

::: code-group

```bash [pnpm]
pnpm add @super-line/plugin-auth @super-line/plugin-chat
```

```bash [npm]
npm install @super-line/plugin-auth @super-line/plugin-chat
```

```bash [yarn]
yarn add @super-line/plugin-auth @super-line/plugin-chat
```

:::

## 2. Merge both onto the contract

A plugin's collections, roles, and requests merge **into the one contract** via `plugins: [...]`. `authContract()` brings the `guest` role, `users`/`credentials`/`sessions`, and `signIn`/`signUp`/`signOut`/`whoami`. `chatContract()` brings six collections (`channels`/`memberships`/`messages`/…) and ~20 request verbs. You declare almost nothing:

```ts [src/contract.ts]
import { defineContract, type RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

export const app = defineContract({
  roles: { user: {} }, // your role — do NOT declare `guest`; the auth plugin adds it
  plugins: [authContract(), chatContract()],
})

// Types flow from the merged contract — one source of truth, no codegen.
export type Message = RowOf<typeof app, 'messages'>
```

::: tip A plugin *is* a merge, not a side-table
`RowOf<typeof app, 'messages'>` resolves because `messages` really is on this contract now — the same mechanism as your own `collections` block, just contributed by the fragment. See [the plugin model](/concepts/plugins).
:::

## 3. Wire the server — kits, not handlers

`auth()` returns an `authKit`; `chat()` a `chatKit`. Their `.plugin` halves carry every policy and handler — membership-scoped read RLS, write-deny, all the request implementations. Your three auth touch-points are `authenticate`, `identify`, and the plugin arrays; your one piece of custom logic here is a **hook**, the un-bypassable extension seam that fires for browser requests and server-side calls alike:

```ts [src/server.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { auth } from '@super-line/plugin-auth/server'
import { chat } from '@super-line/plugin-chat/server'
import { app } from './contract'

const server = http.createServer()
const backend = memoryCollections() // ONE backend serves your collections AND the plugins'

export const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
export const chatKit = chat({
  contract: app,
  hooks: {
    sendMessage: {
      before: (input) => {
        const content = typeof input.content === 'string' ? input.content.trim() : input.content
        if (!content) throw new Error('empty message') // veto — nothing is written
        return { ...input, content } // transform — every message arrives trimmed
      },
    },
  },
})

export const srv = createSuperLineServer(app, {
  nodeKey: 'my-line-1',               // stable per replica — plugin-auth keys sessions on it
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  authenticate: authKit.authenticate, // passwords, access tokens, API keys, JWT — all handled
  identify: authKit.identify,         // principal := userId — drives YOUR policies and chat's
  plugins: [authKit.plugin, chatKit.plugin],
})

server.listen(3000, () => console.log('super-line chat server on ws://localhost:3000'))
```

Compare this to Tutorial 4: there you wrote the `notes` policy yourself — that skill still matters for *your* collections (and `principal` is now a real logged-in `userId`, not a handshake claim). But `channels`, `memberships`, `messages`? Their policies shipped in `chatKit.plugin`.

## 4. Sign up and chat from the client

`authClient` wraps the guest↔authed session replacement behind plain `signUp`/`signIn`/`signOut`; `chatClient` wraps the chat verbs and live message windows. Append a tracer to `src/server.ts` (below `listen`), or keep it as its own file importing the kits:

```ts [src/app.ts]
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { authClient } from '@super-line/plugin-auth/client'
import { chatClient } from '@super-line/plugin-chat/client'
import { app } from './contract'
import { authKit, chatKit } from './server'

// Seed a teammate + a public channel, server-side (trusted kit calls).
const grace = await authKit.users.create({ displayName: 'Grace' })
const channel = await chatKit.channels.create({ name: 'welcome', visibility: 'public', owner: grace.id })

// The reader's side: sign up, then chat as that user.
const connect = ({ role, params }: { role: string; params: Record<string, string> }) =>
  createSuperLineClient(app, {
    transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
    role: role as 'user',
    params,
  })

let stored: string | null = null // in the browser, omit `storage` — it defaults to localStorage
const ada = authClient({
  authedRole: 'user',
  connect,
  storage: { get: () => stored, set: (t) => (stored = t) },
})
await ada.ready
await ada.signUp({ email: 'ada@example.com', password: 'correct-horse', displayName: 'Ada' })
console.log('ada →', ada.state.status, ada.state.displayName, ada.state.roles)

const cc = chatClient(ada.client, { userId: ada.state.userId! })
await cc.join(channel.id) // public channel → self-join

const feed = cc.messages(channel.id)
await feed.ready
feed.subscribe(() => {
  const last = feed.rows().at(-1)
  if (last) console.log(`💬 ${last.authorId === grace.id ? 'Grace' : 'Ada'}: ${last.content}`)
})

await cc.send(channel.id, '  hi!  ') // note the padding — your sendMessage hook trims it
await chatKit.messages.send({ channelId: channel.id, authorId: grace.id, content: 'welcome aboard 👋' })

await new Promise((r) => setTimeout(r, 300))
ada.client.close()
```

## 5. Run it

```bash
npx tsx src/app.ts
```

```ansi
super-line chat server on ws://localhost:3000
ada → authed Ada [ 'user' ]
💬 Ada: hi!
💬 Grace: welcome aboard 👋
```

<div class="sl-result">
  <p class="sl-result__h">A real login and a whole chat domain — and you wrote neither.</p>
  <p>Ada's password was scrypt-hashed and a session minted by <code>authKit</code>; <code>identify</code> made her the <strong>principal</strong> behind every policy; her <code>send</code> was validated, <strong>trimmed by your hook</strong>, stamped, and fanned out by <code>chatKit</code>'s handlers; and Grace's reply came through the imperative server kit — the exact door an AI agent uses. The demo at the top is this code, live.</p>
</div>

## The same, in React

The browser story is two providers that feed the one registered binding from [Tutorial 3](/tutorials/react-hooks) — no bridge code:

```tsx
import { SuperLineAuthProvider, useAuth } from '@super-line/plugin-auth/react'
import { ChatProvider, useChannels, useMessages } from '@super-line/plugin-chat/react'

createRoot(el).render(
  <SuperLineAuthProvider authedRole="user" connect={connect}>
    <ChatProvider>
      <App /> {/* useAuth() → { state, signIn, signUp, signOut }; every data hook follows the session */}
    </ChatProvider>
  </SuperLineAuthProvider>,
)
```

`<SuperLineAuthProvider>` owns the session lifecycle **and** feeds `useCollection`/`useDoc`/`useRequest`/… — before sign-in they idle (reads empty, writes reject); after sign-in they follow the new session automatically. `<ChatProvider>` auto-builds the chat binding on top. See [Add authentication](/how-to/plugin-auth) and [the chat plugin](/how-to/plugin-chat).

## What just happened

| What you wrote | Role | What it does |
| --- | --- | --- |
| `plugins: [authContract(), chatContract()]` | **Contract** | Merges identity + the whole chat model into your one contract. |
| `auth({ … })` / `chat({ … })` kits | **Server** | Ship every policy and handler; expose trusted imperative surfaces (`users.create`, `messages.send`). |
| `authenticate` + `identify` + `nodeKey` | **Server** | The three auth touch-points; `principal := userId` everywhere. |
| `hooks.sendMessage.before` | **Server** | Transform or veto any op — for browsers, kits, and agents alike. |
| `authClient` / `chatClient` | **Client** | The guest↔authed replacement machine; typed chat verbs + live message windows. |

## Next: state that merges

Chat messages are rows — last-writer-wins, and that's right for them. But a shared canvas, a rich-text doc, a scene graph want two people editing **at once** without clobbering each other. That's the other consistency model.

<div class="sl-result">
  <p class="sl-result__h">Continue the series</p>
  <p><strong><a href="/tutorials/collaborate-with-crdt">Tutorial 6 · Collaborate on one document →</a></strong> — CRDT document collections: open by id, edit concurrently, merge — with every write still schema-validated.</p>
</div>

### Or branch off from here

- [Add authentication (plugin)](/how-to/plugin-auth) — everything the kit wires, including the React provider.
- [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys) · [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens) — the other credential shapes.
- [Add a chat backbone (plugin)](/how-to/plugin-chat) — structured message bodies, the imperative kit, all the hooks.
- [Run an AI chat bot](/how-to/chat-bots) — the agent side of the same door Grace used.
- [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat) — a Slack-like app built on exactly this pairing.
