# Tutorials

Five lessons, in order. Each one is a **hands-on build** with a guaranteed outcome at the end — follow the steps and it works. This is the fastest way to feel how super-line fits together; once a pattern clicks here, the [How-to guides](/how-to/) and [Concepts](/concepts/) go deeper on demand.

<div class="sl-qs-hero">

<p class="sl-qs-meta">
  <span>~50 minutes end to end</span>
  <span>Node 18+</span>
  <span>TypeScript · zero codegen</span>
</p>

</div>

## The path

### 1 · [Your first typed round-trip](/tutorials/first-round-trip)

Stand up a server and a client from an empty folder and exercise **all three wire patterns at once** — a request, a pushed event, and a subscribable topic — over one typed connection. The foundation everything else builds on.

*You'll touch:* `defineContract`, `createSuperLineServer`, `createSuperLineClient`, roles, and runtime validation.

### 2 · [Your first collection](/tutorials/first-collection)

Add **persisted, typed state**: declare a collection on the contract, give the server a backend and a row policy, then subscribe to a live, filtered row-set from the client and watch a write converge. This is the leap from messaging to a server-authoritative sync source.

*You'll touch:* [`collections` on the contract](/collections/row-collections), [row-level policies](/collections/policies), `client.collection(...).subscribe(...)`.

### 3 · [Go collaborative — a CRDT document](/tutorials/go-collaborative)

Open a **CRDT document collection** by id, bind it to a UI, and open two tabs — concurrent edits to different fields **merge** instead of clobbering, and every write is still schema-validated on the contract.

*You'll touch:* [CRDT document collections](/collections/crdt-documents), `client.collection(...).open(id)`, the reactive `DocHandle`.

### 4 · [Assemble a chat backbone (a plugin)](/tutorials/chat-backbone)

Merge two **plugins** into one contract — [`@super-line/plugin-auth`](/how-to/plugin-auth) for identity, [`@super-line/plugin-chat`](/how-to/plugin-chat) for channels, membership, and messages — then watch two users talk over a model you never wrote a policy or handler for. This is where the hand-rolled collection from Tutorial 2 becomes a reusable, hookable backbone.

*You'll touch:* [contract-fragment plugins](/concepts/plugins), [the chat plugin](/how-to/plugin-chat), domain hooks, `chatClient`.

### 5 · [Put a live AI agent in the chat](/tutorials/ai-agent-chat)

Add a third participant to that channel — an **AI agent**. Because super-line has no bot type, the agent is a regular API-key user on the same wire, and three library calls turn it into a live participant whose whole answer **streams** into the channel as one message. Runs fully offline, then swaps in a real LLM in one block.

*You'll touch:* [`provisionChatBot` + `onChatMessage`](/how-to/chat-bots), [streamed messages](/how-to/chat-streaming), the `chatAgentTools` AI SDK toolset.

## Before you start

Everything runs on **Node 18+** with TypeScript and [`tsx`](https://tsx.is) — no build step while you learn. super-line is ESM-only. Each lesson is self-contained, but they share a mental model, so do them in order the first time.

When you're ready to build your own thing, jump to the [How-to guides](/how-to/) for task recipes, [Concepts](/concepts/) for the model behind the API, or the [API reference](/reference/) for every export.
