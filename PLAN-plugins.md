# PLAN — super-line plugins (paired runtime bundles)

- Status: **Designed** 2026-07-04 (grill session; decision recorded in
  ADR-0005), not built.
- Goal: one extension concept serving app operators (observability taps) and
  library authors (packaged ADR-0004 runtime weave), strong enough to
  re-express the inspector + Control Center as a plugin — the acceptance test.

## Shape

```ts
// compile-time half stays explicit (types hang off the contract object):
const api = defineContract(mergeSurfaces(appSurface, harnessSurface))

// server — one mount line for the runtime half
const srv = createSuperLineServer(api, {
  plugins: [harness({ historyLimit: 200 }), otel()],
})
srv.implement({
  'app.send': async (input, ctx, conn) => { /* ... */ },
  // 'harness.*' keys NOT required — subtracted at compile time
})

// client — the pair's other half
const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url }),
  role: 'user',
  plugins: [harnessClient()],
})
```

```ts
interface SuperLinePlugin<S extends Directional = {}> {
  name: string                                         // unique; duplicate → startup throw
  onEvent?: (e: TapEvent) => void                      // node-local tap: live refs, don't mutate
  use?: Middleware[]                                   // after host use, plugins in array order
  onConnection?: ...; onDisconnect?: ...; onError?: ...// multiplexed with host's
  handlers?: (ctx: PluginContext) => HandlersFor<S>    // compile against the paired Surface
  stores?: Record<string, ServerStore>                 // collision with host stores → startup throw
  setup?: (ctx: PluginContext) => void | (() => void)  // dispose called on server.close()
}
```

`PluginContext`: the public server surface — `room`/`publish`/`subscribe`/
`store`/`toConn`/`toUser`, presence queries — minus footguns (`implement`,
`close`), plus a privileged block: `channel(name)` on the adapter under a
reserved `x:<plugin>:` prefix, node identity (`nodeId`/`nodeName`/
`instanceId`), the serializer, a read-only conns view, and contract
reflection. Sized to the inspector's audited needs; grows case-by-case.

Client half mirrors, smaller: `stores` (ClientStore halves), `implement`
handlers for the library's server→client requests, and
`onConnect`/`onDisconnect`/`onReconnect`. A client-side tap is type-reserved
but not instrumented in v1.

## Phase 1 — taps, bundles, context

1. **Tap dispatch.** Generalize `emitInspectorEvent`
   (`server/src/index.ts:561`) into a multi-consumer tap; the ~25 emit sites
   keep their boolean fast path (now "any consumer registered"). The inspector
   becomes consumer #1: safeSnapshot, redact, and envelope stamping move
   *inside* the inspector consumer — local taps receive live references.
   Public taxonomy = InspectorEvent minus the envelope.
2. **`plugins` option + multiplexing.** Name uniqueness (throw), lifecycle
   hook fan-out (host first, then array order), middleware concatenation,
   per-listener try/catch routed to `onError` (a throwing tap never fails a
   user operation; a throwing middleware still rejects the op).
3. **`PluginContext`.** Public surface + privileged block; claim the `x:`
   channel prefix beside `r:/t:/c:/u:/reply:/i:/s:`
   (`server/src/index.ts:79-91`); `setup`/dispose wired into `server.close()`.
4. **Typed subtraction.** `SuperLinePlugin<S>`, const plugins tuple generic on
   `createSuperLineServer`, `implement` requires
   `Omit<Handlers<C, A>, HandledKeys<P>>`; type-level tests. The runtime
   completeness throw (missing/duplicate keys named) ships regardless, so
   inference fragility can only degrade DX, never correctness.
5. **Plugin stores.** Merged into the stores config; collision → startup throw
   naming the key.
6. **Client pair.** `SuperLineClientPlugin` + `plugins` option; client
   lifecycle callbacks (`onConnect`/`onDisconnect`/`onReconnect`) added as
   multiplexed hooks and plain options; client store merge + `implement`
   collision throw (today it's a last-write-wins Map).
7. **Docs.** New `guide/plugins.md`; update `composition.md` (library authors
   export a Surface + plugin pair) and `middleware-lifecycle.md` cross-links.
   Control Center unchanged in this phase.

## Phase 2 — plugin-owned connections, inspector extraction

1. **Plugin-owned connections.** Generalize the reserved-role mechanism
   (`INSPECTOR_ROLE` + WS subprotocol negotiation, observer-invisible conns):
   a plugin declares a connection class — role name, handshake negotiation,
   its own fixed parallel contract (never merged into the user's), visibility
   flags (excluded from conns/presence/heartbeat/user hooks). Transports
   cooperate through the existing start-hooks bundle; today only
   transport-websocket has the negotiation.
2. **Extract `@super-line/plugin-inspector`.** Taps → snapshot/redact →
   `i:events`; serves CC connections via its plugin-owned connection class;
   `inspector: true` becomes sugar constructing the plugin; the CC wire format
   is unchanged (existing CC tests are the regression suite).

## Deliberately out of scope

- Interception: transforming or vetoing in-flight traffic (rejected in
  ADR-0005 — encode-once fan-out + echo-break invariants).
- Client tap instrumentation (type reserved only).
- Middleware visibility into unknown-name probes (pre-existing gap,
  orthogonal to plugins).
- Plugin discovery/registry — plugins are constructed and passed, like every
  other seam.
