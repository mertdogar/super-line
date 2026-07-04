# Composition — embedding a super-line library

You built a library on super-line — it has its own contract, handlers, and stores. Now a host app that *also* runs super-line wants to embed it. Two servers would mean two sockets, two handshakes, two identities. Composition gives you **one server, one client, one session, one identity**: the library exports its contract *pieces*, and the host weaves them into its own.

There is no namespace field on the wire — namespacing is a **key-prefix convention** plus two helpers that make collisions impossible to miss:

- **`defineSurface`** — author an exportable contract fragment (one `{ clientToServer, serverToClient }` block).
- **`mergeSurfaces`** — combine two fragments; a duplicate key is a **compile error naming the key** (and a runtime throw), never a silent spread-clobber.

## Library side: export a surface

```ts
import { z } from 'zod'
import { defineSurface } from '@super-line/core'

// keys hard-prefixed in source — `lib.` is yours; pick something unmistakable
export const libSurface = defineSurface({
  clientToServer: {
    'lib.join': { input: z.object({ threadId: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
  serverToClient: {
    'lib.suspended': { payload: z.object({ threadId: z.string() }) },
    'lib.feed': { payload: z.object({ text: z.string() }), subscribe: true },
  },
})
```

::: warning Why `defineSurface` and not a plain `const`?
`defineContract` preserves literal types for *inline* contracts, but a fragment declared as a plain `const` widens `subscribe: true` to `boolean` — and your topic **silently degrades to a push event** after merging. `defineSurface` is an identity function with the same `const` type parameter, so the literal survives.
:::

Alongside the surface, export your runtime pieces as factories, prefixed the same way:

```ts
export const libHandlers = (deps: LibDeps) => ({
  'lib.join': async (input, ctx, conn) => { /* … */ },
})
export const libStores = (cfg: LibConfig) => ({
  'lib.threads': memoryStoreServer(),
})
```

Three more library-side rules:

1. **Prefix room names too** — rooms are runtime strings no helper can collision-check. ``conn.join(`lib:thread:${id}`)``, never ``conn.join(`thread:${id}`)``.
2. **Declare `@super-line/*` as `peerDependencies`** — host and library must share one core instance.
3. **Keep your standalone entry point** — it just mounts the same fragments into a trivial contract of its own, so the library works with or without a host.

## Host side: mount it

```ts
import { defineContract, defineSurface, mergeSurfaces } from '@super-line/core'
import { libSurface, libHandlers, libStores } from 'your-lib'

const userSurface = defineSurface({
  clientToServer: { say: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) } },
  serverToClient: { posted: { payload: z.object({ id: z.string() }) } },
})

export const api = defineContract({
  roles: {
    user: mergeSurfaces(libSurface, userSurface),   // ← the library rides this role
    admin: adminSurface,                            // ← and not this one
  },
})

const srv = createSuperLineServer(api, {
  transports: [webSocketServerTransport({ server })],
  authenticate,                                     // ONE handshake — yours
  stores: { ...libStores(cfg), ...myStores },
})
srv.implement({ user: { ...libHandlers(deps), ...myHandlers } })
```

Mounting decisions, in order:

- **Which block gets the surface?** Merge into `shared` and *every* role sees the library; merge into one role and it's scoped. Scope it unless you're sure.
- **`data` stays yours** — `mergeSurfaces` deliberately rejects role blocks: a role's `data` schema, like roles and auth, belongs to the host. Add it beside the merge: `user: { ...mergeSurfaces(libSurface, userSurface), data: myDataSchema }`.
- **You can't forget the handlers.** `implement` requires a handler for every merged key — dropping `...libHandlers(deps)` is a compile error, not a runtime 404.
- **Your middleware runs on library requests too.** That's the point (it's how shared auth manifests), but remember it when rate-limiting.

The client mirrors the server: one `createSuperLineClient(api, …)`, and the library exposes its client-side helpers over your client instance.

::: tip Package the weave as a plugin
Exporting handlers, stores, and middleware as separate factories and wiring them by hand at four config sites works — but a [**plugin**](./plugins) bundles them into one mountable unit (`plugins: [lib()]`), multiplexes lifecycle hooks so two libraries can coexist, and **subtracts** the library's handler keys from your `implement()` obligation. The surface merge above stays exactly the same; the plugin just carries the runtime half.
:::

## Collisions

```ts
mergeSurfaces(libSurface, defineSurface({
  clientToServer: { 'lib.join': { input: z.void(), output: z.void() } },
}))
// compile error: … not assignable … { 'mergeSurfaces: duplicate keys': "lib.join" }
// runtime (untyped callers): Error: mergeSurfaces: duplicate keys: lib.join — rename or prefix
```

The same key in *opposite* directions is **not** a collision — a request and an event may share a name.

## When composition isn't the tool

Composition assumes the two surfaces should share identity and lifecycle. If you need two **independent** stacks — separate `authenticate`, separate reconnect, true third-party isolation — that's a different problem: two sockets (fine in practice), or the deferred mux-transport design (`PLAN-transport-mux.md` at the repo root). The reasoning lives in [ADR-0004](https://github.com/mertdogar/super-line/blob/main/docs/adr/0004-composition-over-connection-namespaces.md).

## Library author checklist

- [ ] Keys prefixed in source: requests/events/topics (`lib.join`), store names (`lib.threads`), room names (`lib:…`)
- [ ] Surface exported via `defineSurface`; handlers + stores exported as factories
- [ ] `@super-line/*` in `peerDependencies`
- [ ] Standalone entry point mounts the same fragments
- [ ] Document the `ctx` shape your handlers need from the host's `authenticate`

Next: [Testing](./testing).
