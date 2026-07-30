# Tutorials

A single learning path, seven steps. Each step is a **hands-on build** with a guaranteed outcome — and each begins with a **live demo**: a real super-line server booted *inside the page* (over the in-memory loopback transport), running the same code you're about to write. You see the thing work, then you build it, then your build behaves exactly like the demo did.

<div class="sl-qs-hero">

<p class="sl-qs-meta">
  <span>~50 minutes end to end</span>
  <span>Node 18+</span>
  <span>live in-page demos · zero codegen</span>
</p>

</div>

## The path

### 1 · [Run a super-line server](/tutorials/run-a-server)

Two files — a **contract** declaring every interaction, and a **server** implementing it — booted on a WebSocket wire. The in-page server streams its own real diagnostics while you build yours.

*You'll touch:* `defineContract`, `createSuperLineServer`, `authenticate`, roles, transports.

### 2 · [Connect a typed client](/tutorials/connect-a-client)

The client imports the **same contract** and gets the whole surface inferred: call the request, listen for the event, subscribe to the topic — then watch the server reject a hand-crafted invalid payload types couldn't stop.

*You'll touch:* `createSuperLineClient`, `send`/`on`/`subscribe`, `SuperLineError`, server-side validation.

### 3 · [Make it React](/tutorials/react-hooks)

Register your contract once and every hook is typed by it. Two **real React apps run on the page**, sharing one live row-set — and the component source shown is the module actually running.

*You'll touch:* `Register`, `SuperLineProvider`, `useSuperLineClient`, `useRequest`/`useEvent`/`useSubscription`, `useCollection`.

### 4 · [Store your data](/tutorials/store-your-data)

The machinery under `useCollection`: declare a typed collection on the contract, fence it with deny-by-default **row-level policies**, and hand the server a **storage backend**. Then stop the server and boot a new one on the same backend — the rows survive, because servers are replaceable and backends aren't.

*You'll touch:* [`collections`](/collections/row-collections) on the contract, [policies](/collections/policies), `identify`, memory → SQLite [backends](/collections/backends).

### 5 · [Add auth + chat — plugins snap in whole domains](/tutorials/add-auth-and-chat)

Merge `authContract()` and `chatContract()` onto your contract and wire their server kits: real sign-up (the in-page demo scrypt-hashes your password with the actual plugin), durable sessions, and a full channels/membership/messages model — none of which you implement.

*You'll touch:* [plugin-auth](/how-to/plugin-auth), [plugin-chat](/how-to/plugin-chat), `authClient`, `chatClient`, domain hooks, `nodeKey`.

### 6 · [Collaborate on one document](/tutorials/collaborate-with-crdt)

Rows are last-writer-wins; a shared canvas wants **merge**. Open a CRDT document from two clients, edit different fields simultaneously, and watch both edits survive — with every write still schema-validated before it commits.

*You'll touch:* [CRDT document collections](/collections/crdt-documents), `open(id)`, the `DocHandle`, validate-before-commit, `useDoc`.

### 7 · [Go multi-node](/tutorials/go-multi-node)

Read a complete **adapter** (it fits on the page), run a two-node cluster in the tab, and sever its bus with a button. Then the one-line Redis swap, and the cluster event bus for server↔server coordination.

*You'll touch:* the `Adapter` seam, `adapter:` option, `srv.publish`/`srv.subscribe`, Redis/libp2p adapters.

## Going deeper

Three larger builds continue where the path ends — same project style, bigger payoffs:

- **[Put a live AI agent in the chat](/tutorials/ai-agent-chat)** — an agent is just a provisioned user with an API key; three library calls make it a live, streaming participant in the Tutorial 5 channel.
- **[Co-edit a canvas with an agent](/tutorials/collaborative-canvas-with-agent)** — a human and an AI agent as co-writers on one Tutorial 6-style document, attached to a chat channel.
- **[Run your first durable job](/tutorials/first-queue)** — server-only queues, workers, retries, and cron as another paired plugin.

## Before you start

Everything runs on **Node 18+** with TypeScript and [`tsx`](https://tsx.is) — no build step while you learn. super-line is ESM-only (`"type": "module"`). The steps share one small project and a mental model that builds in order, so walk the path top to bottom the first time; each page still stands alone if you're returning for a refresher.

The in-page demos run the real npm packages over the loopback transport, and every demo carries a *"What's real here"* caption so you always know which part is the library and which part is staging. If a demo can't start in your browser, the code on the page is the same wiring — run it locally instead.

When you're ready to build your own thing: [How-to guides](/how-to/) for task recipes, [Concepts](/concepts/) for the model behind the API, [Collections](/collections/) for the data layer, and the [API reference](/reference/) for every export.
