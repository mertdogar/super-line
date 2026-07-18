# Tutorial 4 · Assemble a chat backbone (a plugin)

<p class="sl-qs-crumb"><a href="/tutorials/">Tutorials</a> → <a href="/tutorials/first-collection">2 · Your first collection</a> → <a href="/tutorials/go-collaborative">3 · Go collaborative</a> → <strong>4 · Assemble a chat backbone</strong></p>

<div class="sl-qs-hero">

<p class="sl-qs-hero__lede">
In <a href="/tutorials/first-collection">Tutorial 2</a> you hand-wrote a collection, an <code>identify</code>, and a row policy for a single <code>messages</code> table. A real chat app is a <em>lot</em> of that — channels, membership, owner/member roles, per-channel message security. <strong><code>@super-line/plugin-chat</code></strong> ships that whole model as one plugin you merge into your contract; <strong><code>@super-line/plugin-auth</code></strong> gives it identity. By the end, two users will talk over a channel you never wrote a single policy or handler for.
</p>

<p class="sl-qs-meta">
  <span>~10 minutes</span>
  <span>Builds on Tutorials 1–2</span>
  <span>TypeScript · zero codegen</span>
</p>

<p class="sl-qs-patterns">
  <span class="sl-qs-pill"><b>Merge</b> two <code>plugins</code></span>
  <span class="sl-qs-pill"><b>Hook</b> a domain op</span>
  <span class="sl-qs-pill"><b>Chat</b> <code>chatClient</code></span>
</p>

</div>

This lesson continues the `my-line` project from [Tutorial 1](/tutorials/first-round-trip) — same folder, same ESM + `tsx` setup, Node 18+. Unlike the earlier lessons we'll run the whole thing as **one file**, a tracer you can read top to bottom: a server, two provisioned users, and a live message crossing between them. For the model behind it, see [the chat plugin how-to](/how-to/plugin-chat) and [the plugin concept](/concepts/plugins).

## 1. Install the two plugins

The chat plugin is a **paired plugin**, and [`@super-line/plugin-auth`](/how-to/plugin-auth) is a hard prerequisite — chat rows reference its `users` directory, and every action is keyed on the signed-in user. You already have `core`, `server`, `client`, the transport, and `zod` from the earlier tutorials; add the plugins and the in-memory collection backend they sync through.

::: code-group

```bash [pnpm]
pnpm add @super-line/plugin-auth @super-line/plugin-chat @super-line/collections-memory
```

```bash [npm]
npm install @super-line/plugin-auth @super-line/plugin-chat @super-line/collections-memory
```

```bash [yarn]
yarn add @super-line/plugin-auth @super-line/plugin-chat @super-line/collections-memory
```

:::

## 2. Merge both plugins into the contract

A plugin's collections, roles, and surface merge **straight into the contract** via `plugins: [...]` on `defineContract`. `authContract()` brings identity; `chatContract()` brings the entire chat model — six collections (`channels` / `memberships` / `messages` / `messageParts` / `resources` / `resourcePresence`) and the 20 mutation requests (`createChannel`, `joinChannel`, `addMember`, `sendMessage`, `editMessage`, `startMessage`, `createResource`, …). You declare almost nothing yourself.

```ts [src/contract.ts]
import { defineContract, type RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

export const chat = defineContract({
  roles: { user: {} },                          // your app's role — the plugins fill in the rest
  plugins: [authContract(), chatContract()],
})

// Types flow from the merged contract — one source of truth, no codegen.
export type Channel = RowOf<typeof chat, 'channels'>
export type Message = RowOf<typeof chat, 'messages'>
```

`chatContract()` defaults the **message body to plain text** (`z.string()`). Pass a schema — `chatContract({ content })` — to make messages structured; the server then validates every body and the type flows end-to-end. We'll stay with text.

::: tip A plugin *is* a merge into the contract
`RowOf<typeof chat, 'messages'>` resolves because `messages` really is on this contract now — the plugin didn't register a side-table, it merged into the one definition both ends import. See [the contract model](/concepts/the-contract).
:::

## 3. Wire the server — no policies, no handlers

Here's the payoff. `auth()` returns an `authKit`; `chat()` returns a `chatKit`. Register **both plugins** and the chat model's row policies (read = membership-scoped RLS, write = deny) and all 20 request handlers ship *inside* `chatKit.plugin`. This file writes **no** channel/message policy or handler of its own — compare that to the hand-rolled `policies.messages` you wrote in [Tutorial 2](/tutorials/first-collection).

The one thing you *do* get to add is a **hook**: a before/after wrapper around a domain operation that fires for client requests and server-side calls alike — the un-bypassable extension seam ([ADR-0010](https://github.com/mertdogar/super-line/blob/main/docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md)).

```ts [src/chat-backbone.ts]
import http from 'node:http'
import { createSuperLineServer } from '@super-line/server'
import { createSuperLineClient } from '@super-line/client'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'
import { memoryCollections } from '@super-line/collections-memory'
import { auth } from '@super-line/plugin-auth/server'
import { chat as chatKitFactory } from '@super-line/plugin-chat/server'
import { chatClient } from '@super-line/plugin-chat/client'
import { chat } from './contract'

const server = http.createServer()
const backend = memoryCollections()                 // one backend serves auth AND chat collections

const authKit = auth({ contract: chat, collections: backend, defaultRoles: ['user'] })
const chatKit = chatKitFactory({
  contract: chat,
  hooks: {
    // fires for browser requests AND imperative chatKit calls — one place a host can never forget to call
    sendMessage: {
      before: (input) => {
        const content = typeof input.content === 'string' ? input.content.trim() : input.content
        if (!content) throw new Error('empty message')
        return { ...input, content }              // return to transform; throw to veto (nothing is written)
      },
    },
  },
})

createSuperLineServer(chat, {
  transports: [webSocketServerTransport({ server })],
  collections: backend,
  plugins: [authKit.plugin, chatKit.plugin],        // both halves of the model live here
  authenticate: authKit.authenticate,               // sessions / API keys / JWT — all handled
  identify: authKit.identify,                        // principal := userId → drives chat's read policies
})

server.listen(3000, () => console.log('super-line chat server on ws://localhost:3000'))
```

## 4. Provision two users, then talk over the wire

Identity mutations (`signUp`, `signIn`) are how a **browser** logs in — that's the [plugin-auth how-to](/how-to/plugin-auth), where `authClient()` / `createAuth()` wrap the guest↔user reconnect. For a headless tracer it's simpler to provision users **server-side** with the imperative `authKit`, mint each an API key, and connect two ordinary clients — the exact pattern an AI agent uses.

Append this to `src/chat-backbone.ts`, below the `listen` call:

```ts [src/chat-backbone.ts]
// Provision Ada and Bob as real users + API keys (server-authoritative; no passwords needed here).
const ada = await authKit.users.create({ email: 'ada@my.line', displayName: 'Ada' })
const bob = await authKit.users.create({ email: 'bob@my.line', displayName: 'Bob' })
const adaKey = (await authKit.apiKeys.create(ada.id, { role: 'user', label: 'tracer' })).key
const bobKey = (await authKit.apiKeys.create(bob.id, { role: 'user', label: 'tracer' })).key

// Each connects an ordinary super-line client, then wraps it in a chatClient (no React/TanStack needed).
const connect = (apiKey: string, userId: string) =>
  chatClient(
    createSuperLineClient(chat, {
      transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
      role: 'user',
      params: { apiKey },
    }),
    { userId },
  )

const adaChat = connect(adaKey, ada.id)
const bobChat = connect(bobKey, bob.id)
await Promise.all([adaChat.ready, bobChat.ready])

// Ada creates a PRIVATE channel (she becomes its owner) and adds Bob — owner-driven membership.
const channel = await adaChat.createChannel({ name: 'launch', visibility: 'private' })
await adaChat.addMember(channel.id, bob.id)

// Bob opens a live message window on the channel he was just added to, and reacts to new messages.
const feed = bobChat.messages(channel.id)
await feed.ready
feed.subscribe(() => {
  const last = feed.rows().at(-1)
  if (last) console.log(`💬 Bob sees — ${last.content}`)
})

// Ada sends. It's a server-authoritative request: the server stamps the id + timestamp, runs the
// sendMessage hook (trim/reject-empty), then fans it out. Bob's feed updates from the wire.
await adaChat.send(channel.id, '  we ship at noon  ') // note the padding — the hook trims it

await new Promise((r) => setTimeout(r, 300))          // let the live message land, then exit
adaChat.close()
bobChat.close()
```

::: tip Every mutation is a request, not a row-write
Unlike Tutorial 2 — where the client `insert`ed a row directly — the chat plugin makes each mutation a **request** handled server-side. That's why ids and timestamps are authoritative and a `before` hook can trim or reject any write, for a human and an agent alike. The reasoning is [ADR-0010](https://github.com/mertdogar/super-line/blob/main/docs/adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md).
:::

## 5. Run it

One file, one command:

```bash
npx tsx src/chat-backbone.ts
```

```ansi
super-line chat server on ws://localhost:3000
💬 Bob sees — we ship at noon
```

<div class="sl-result">
  <p class="sl-result__h">Two users just chatted over a model you never wrote.</p>
  <p>Ada created a <strong>private</strong> channel and <strong>added</strong> Bob to it; her <code>send</code> travelled to the server, which validated the body, ran your <code>sendMessage</code> hook (notice the padding was <strong>trimmed</strong>), stamped the id and timestamp, and fanned it out — and Bob's live <code>messages</code> window, opened only because he's a member, delivered it. The channel row, the membership RLS, the message security, the 20 request handlers: all of it came from <code>chatKit.plugin</code>.</p>
</div>

## What just happened

Each line you wrote is one seam of the plugin backbone — the plugin owns the durable model, your app owns the wiring and the garnish:

| What you wrote | Role | What it does |
| --- | --- | --- |
| `plugins: [authContract(), chatContract()]` | **Contract** | Merges identity + the whole chat model (collections + requests) into one contract. |
| `authKit.plugin` + `chatKit.plugin` | **Server** | Ships the read-RLS/write-deny policies and every request handler — you add none. |
| `hooks: { sendMessage: { before } }` | **Server** | The un-bypassable extension point: transform or veto any op, for clients and agents alike. |
| `chatClient(client, { userId })` | **Client** | Typed request methods (`send`, `createChannel`, `addMember`) + live stores that re-subscribe on membership change. |

The membership model is the part worth internalising: a **private** channel is invisible to non-members and its messages never cross the wire to them; a **public** one is discoverable and self-join (`chatClient.join`). Members carry an `owner` or `member` role — the creator is the first owner, owners manage membership, and the server refuses to strip a channel's **last owner**. All of it is enforced at the source, so tampering with a client just earns a `FORBIDDEN`.

## Next: a live AI agent

You drove the plugin headlessly. The obvious next step: because an agent is just a provisioned user with an API key, that same `chatClient` becomes a live LLM participant.

- **[Tutorial 5 · Put a live AI agent in the chat](/tutorials/ai-agent-chat)** — provision a bot, run its message loop, and stream its answer into the channel. The natural sequel to this lesson.
- [Add a chat backbone (how-to)](/how-to/plugin-chat) — the full surface: structured message bodies, the imperative `chatKit` (`channels` / `members` / `messages`), the hooks, and the React bindings (`useChannels` / `useMembers` / `useMessages`).
- [Stream an agent's turn (how-to)](/how-to/chat-streaming) — the streamed-message model: one message that accumulates typed parts (text · tool calls · subagent trees) live and survives reloads.
- [Run an AI chat bot (how-to)](/how-to/chat-bots) — `provisionChatBot`, `onChatMessage`, the `chatAgentTools` AI SDK toolset, and the Mastra engine.
- [Add authentication (how-to)](/how-to/plugin-auth) — the browser sign-up / sign-in flow with `authClient()` and `createAuth()`.
- [`examples/collections-chat`](https://github.com/mertdogar/super-line/tree/main/examples/collections-chat) — a Slack-like app built entirely on this plugin, with membership control, presence/typing garnish, and a live AI agent in an `#ask-ai` channel.
