# Attach collaborative resources to channels

A channel's members usually work *on* something — a canvas, a shared todo list, a brief. Channel
resources make that first-class: the **host declares its own [CRDT document
collections](/collections/crdt-documents)** (the schemas stay yours), and `@super-line/plugin-chat` turns them
channel-native — a **link registry** per channel, **server-authoritative creation**,
**membership-gated access** (every member reads and writes, nobody else), an **acked write path**
built for agents, and coarse **who's-open presence**. Design record: `PLAN-chat-resources.md`.

Two runnable versions: [`examples/chat-resources`](https://github.com/mertdogar/super-line/tree/main/examples/chat-resources) is the headless mechanics (CLI, no UI); [`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor) is the full web app — a human and an AI agent editing one canvas live. To build it yourself step by step, follow [Tutorial 6](/tutorials/collaborative-canvas-with-agent).

![A human and an agent editing one canvas: the agent's delegation streams in the chat on the left, its notes and a human's note share the board on the right](/chat-supervisor.jpg)

## The model

A resource is **one CRDT document** plus a **registry row** that links it to a channel. The document is a normal [CRDT document collection](/collections/crdt-documents) you declare on the contract — the plugin never owns your schema. The registry (`resources`) is what makes it channel-native: it records *which* doc is attached to *which* channel, and every access check reads from it.

```
channel  ──< resources (registry) >──  CRDT document
 #design      { channelId, kind,          { title, items: {...} }
              collection, docId, title }   (your schema, opened by id)

           membership(channel) ─┐
                                ├─ gate every read + write + presence row
           resolveResourceAccess(collection, docId) ─┘
```

**Why a link registry and not just an id convention?** You might imagine encoding the channel into the doc id (`design:canvas-1`) and skipping the registry. It doesn't hold up: a doc's id is often **host content that predates the channel** (a design scene's UUID, a document id) and can be **attached to more than one channel** (`linked` kinds). The id can't carry the membership relationship, so access has to be a lookup — "is this doc attached to a channel you're in?" — which is exactly what the registry answers. It's also what lets a resource move or fan out across channels without rewriting doc ids.

Access is **membership-gated through that registry**: registering a kind auto-contributes read/write policies that resolve `channel(s) this doc is attached to → are you a member?`. Every member reads and writes; non-members can't see the doc, its registry row, or its presence rows.

## 1 · Declare the collections (host-owned schemas)

```ts
const app = defineContract({
  collections: {
    todos:    { schema: todoSchema,   crdt: { mode: 'document' } },
    canvases: { schema: canvasSchema, crdt: { mode: 'document' } },
  },
  roles: { user: {} },
  plugins: [authContract(), chatContract()],
})
```

Schemas must be **presence-tolerant** ([ADR-0008](https://github.com/mertdogar/super-line/blob/main/docs/adr/0008-crdt-validation-is-scoped-to-present-values.md)):
fields several members edit concurrently need `.catch()`/`.optional()`. Strict (catch-less) fields
are safe only when set once — and they're the ones a bad write can actually be *rejected* on.

## 2 · Register the kinds (one act, three effects)

```ts
const chatKit = chat({
  contract: app,
  resources: {
    kinds: {
      todo:   { collection: 'todos', init: () => ({ items: {} }) },              // owned (default)
      canvas: { collection: 'canvases', lifecycle: 'linked',
                init: async (c) => seedCanvas(c.params) },                        // host validates params
    },
  },
})
```

Registering a kind **is** the wiring: it enables `createResource` for it, **contributes the
membership-gated read/write policies for that collection** (do *not* also write your own `policies`
entry for it — the server throws `"policy … collides"` at boot; registration owns the policy), and
enrolls the kind in the channel-delete cascade.

Two lifecycles:

| | `owned` (default) | `linked` |
|---|---|---|
| doc id | server-minted | host-suppliable (`createResource({ id })`) |
| channels | exactly one | attachable to many |
| on detach / channel delete | **doc deleted** | registry row removed, doc untouched |

`linked` is for docs that ARE your product content (a design scene, a document) — chat never deletes
them. `createResource` on a linked kind is **create-or-attach**: an existing id attaches (init
skipped), and two racing creators both succeed onto one registry row.

## Server-side: `chatKit.resources`

The requests above have a server-side twin on `chatKit` — running through the same domain cores, but
`initiator.kind === 'server'`, so there's no membership check and (being server-initiated) no card
lands in the message feed:

```ts
chatKit.resources.create({ channelId, kind, title?, id?, params? }) // create-or-attach → ChatResource
chatKit.resources.detach(channelId, kind, docId)                    // → ChatResource; owned kinds delete the doc too
chatKit.resources.of(channelId)                                     // → ChatResource[] — the channel's registry rows
```

[`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor)
uses `of` + `create` to auto-seed every channel with a canvas and a doc the moment it appears, so no
member ever has to attach one by hand:

```ts
const existing = await chatKit.resources.of(channelId)
for (const kind of ['canvas', 'doc'] as const) {
  if (!existing.some((r) => r.kind === kind))
    await chatKit.resources.create({ channelId, kind, title: kind === 'canvas' ? 'Canvas' : 'Doc' })
}
```

See [the chat plugin how-to](/how-to/plugin-chat#server-side-management-—-the-imperative-chatkit) for the
rest of `chatKit` (channels, members, messages) and `sweepPresence`, covered under
[Presence](#_5-·-presence-who-s-in-the-doc) below.

## 3 · Use it from the client

```ts
const chat = chatClient(client, { userId })
const store = chat.resources(channelId)                    // live registry rows
const row   = await chat.createResource(channelId, { kind: 'todo', title: 'Launch list' })

// collaborate through the NATIVE doc surface — chat wraps nothing here
const doc = client.collection(row.collection).open(row.docId)   // or react's useDoc
doc.update({ items: { 'i-1': { text: 'ship it', done: false } } })

await chat.detachResource(channelId, 'todo', row.docId)    // owned ⇒ doc deleted too
```

React: `useChannelResources(channelId)` (live registry) and `useResourcePresence(row)` (below).
Every member — human, bot, or a pod-agent connected as a real client — passes the same membership
gate; unattached docs are invisible through chat entirely.

Creating/attaching/detaching drops a **resource card** into the message stream: a content-less
message carrying `metadata.resource` (`{ action, kind, docId, title }`). Because it's a normal
message row, it arrives in the same `useMessages` feed — branch on the metadata to render it as a
card instead of a bubble:

```tsx
function MessageRow({ m }: { m: FeedMessage }) {
  const card = (m.metadata as { resource?: ResourceCard } | undefined)?.resource
  if (card) {
    return (
      <div className="resource-card">
        {card.action === 'created' ? 'created' : card.action === 'attached' ? 'attached' : 'removed'}{' '}
        <strong>{card.kind}</strong> “{card.title}”
      </div>
    )
  }
  return <Bubble m={m} />
}
```

`onChatMessage` skips cards automatically, so they never trigger a bot turn — the agent won't try
to "answer" its own resource creation.

## 4 · Agent writes: the acked path

`DocHandle` writes are optimistic and `void` — a rejected write surfaces later as a client resync,
which an LLM tool can't observe. Agents (and anything needing a synchronous answer) use
**`writeResource`** instead: path ops applied server-side, validated against the kind's schema on a
projection first, with the post-write snapshot returned — or a `VALIDATION` error whose zod message
the model reads and corrects against.

Paths address **object keys only** (string segments) — an array is replaced wholesale by setting it
at its key; indexing into one is rejected (`VALIDATION`) because CRDT arrays are opaque leaves.

```ts
await chat.writeResource(channelId, 'todo', docId, [
  { path: ['items', 'i-2'], set: { text: 'review palette', done: false } },
  { path: ['items', 'i-1', 'done'], set: true },
  { path: ['items', 'i-0'], delete: true },
])
```

The `/ai` toolset gains `list_resources` · `read_resource` (16 KB-capped snapshot) ·
`create_resource` · `detach_resource` · `write_resource`, all riding the bot's own connection (the
server re-authorizes everything). Pass `resourceShapes: { todo: '{ items: … }' }` so the model knows
each kind's shape without reading first.

## 5 · Presence: who's in the doc

Coarse, row-based (it works on every deployment tier — rooms don't cross nodes on self-tier
clusters), per **user** not per tab:

```ts
const present = useResourcePresence(row)   // announces open/heartbeat/close for you; returns live rows
```

Liveness is `heartbeatAt` recency (20 s beats, 45 s window — `PRESENCE_LIVE_MS`). Reap old rows from
host code with `chatKit.resources.sweepPresence({ olderThanMs })` (the `sweepStale` pattern — the
plugin runs no timers). Live cursors/selections are deliberately out of scope for now.

## Caveats worth knowing

- **Revocation is lazy for open docs**: doc read policies run at open (and every reconnect re-open),
  so a member detached from a `linked` doc keeps receiving deltas until their doc closes or the
  connection drops — the same captured-at-subscribe staleness as row subscriptions. Hard revocation:
  `srv.toUser(userId).disconnect()`.
- **`writeResource` validation is best-effort honesty**, not an engine invariant: server co-writes
  are authoritative by design; a concurrent delta between validate and apply is an accepted tiny
  race. `.catch()` fields never reject — they self-heal at the next client-delta validation.
- **The cascade is sequential, not atomic** (registry rows first, then owned docs): a crash
  mid-cascade can orphan an *invisible* doc (no registry row ⇒ no access), never a dangling row.

## Where to go next

- [**Tutorial 6 — build a chat channel where a human and an agent co-edit a canvas**](/tutorials/collaborative-canvas-with-agent): the guided, guaranteed-outcome build of the app in the screenshot above.
- [**CRDT document collections**](/collections/crdt-documents): the underlying document model — merge semantics, validate-before-commit, and why the schemas must be presence-tolerant.
- [**Chat bots**](/how-to/chat-bots): provisioning the agent as a real channel member so its `write_resource` calls pass the same membership gate as a human.
- [`examples/chat-supervisor`](https://github.com/mertdogar/super-line/tree/main/examples/chat-supervisor): the full source behind the screenshot.
