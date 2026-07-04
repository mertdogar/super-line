# Chat moderation — authoring a super-line plugin

Every other example *mounts* a plugin (`plugins: [inspector()]`). This one **writes** one — a real,
reusable **paired** moderation plugin — and drops it into a chat app, so you can see the whole
"author it → mount it → it just works" workflow. It's the runnable companion to the
[Building a plugin](https://mertdogar.github.io/super-line/guide/building-plugins) guide.

## Run it

```sh
pnpm --filter @super-line/example-chat-moderation dev
```

Open two browser tabs on the printed URL:

1. **Tab A** — join as **ada** with the *Join as moderator* box checked.
2. **Tab B** — join as **bob**, unchecked, same room.
3. In tab A, type `bob` into the mod panel and **Mute**. In tab B a red banner appears and bob's
   messages stop sending (rejected with `FORBIDDEN`). **Unmute** in tab A and bob is back.

Bonus: point the Control Center at it and watch the mutelist live —
`npx @super-line/control-center --url ws://localhost:8787` → **Stores → `mod.muted`**. The plugin's
store is a first-class Store, filterable/sortable like any other.

## What the plugin shows

The plugin is three small files under [`src/moderation/`](./src/moderation) — the shape you'd publish
as `@you/plugin-moderation`:

| File | What it demonstrates |
|---|---|
| [`surface.ts`](./src/moderation/surface.ts) | The **paired typed surface** — `mod.mute` / `mod.unmute` / `mod.list` + a `mod.status` event. The host merges it (see [`contract.ts`](./src/contract.ts)); its keys are **subtracted from `implement()`** at compile time. |
| [`server.ts`](./src/moderation/server.ts) | The **server half**: a contributed **Store** (the mutelist), a **`use` middleware** that gates a muted user's `send` with `FORBIDDEN` (the sanctioned interception seam — plugins never veto via taps), an **`onEvent` audit tap**, and the `mod.*` **handlers**. |
| [`client.ts`](./src/moderation/client.ts) | The **client half**: `onReconnect` — a lifecycle hook the plugin system added to the client — re-syncs the moderator's mutelist after a dropped socket. |

The payoff is in [`src/server.ts`](./src/server.ts): `srv.implement({ user: { join, send } })` — note
`mod.mute` / `mod.unmute` / `mod.list` are **absent**. The plugin owns them, so the type system
subtracts them from the obligation. Add one back and you get a compile error. That's the plugin system
doing its job: a plugin isn't middleware bolted on the side — it's a first-class, typed extension.

## How moderation is enforced

- **The gate is `use` middleware, not a tap.** Taps (`onEvent`) *observe* live traffic; they can't veto
  it. Blocking a muted send is behavior, so it lives in `use`, which rejects by throwing a
  `SuperLineError`. This is the boundary from [ADR-0005](https://github.com/mertdogar/super-line/blob/main/docs/adr/0005-plugins-as-paired-runtime-bundles.md).
- **The mutelist is a Store**, so it's cluster-synced and persistent-capable for free — add an adapter and
  a second node and mutes propagate with no extra code.
- **Moderator authority is app-supplied.** The plugin takes `isModerator(ctx)` so it stays role-agnostic;
  this app marks a connection a moderator from a `?mod=1` handshake param.
