# PLAN: react-dx — one React binding, convenient by default

- Status: **LOCKED** 2026-07-30 (wayfinder map at `.scratch/react-hooks-dx/`; charted + locked in the same effort)
- Companion ADR: `docs/adr/0026-the-react-binding-is-registered-once-and-plugins-feed-it.md` (supersedes ADR-0020 §4)
- Evidence: the charting sweep (file:line for every gap) at `.scratch/react-hooks-dx/assets/sweep-2026-07-30.md`; headline items restated inline below so this PLAN stands alone.

One sentence: **`Register` moves into `@super-line/react` and becomes the single module-level binding every plugin feeds; the hooks grow the conveniences real apps have been hand-rolling** (lazy doc ids, readiness/error, underlying handles, one-shot reads, an auto-built ChatProvider).

## Why now (the evidence, condensed)

- `useDoc(name, id: string)` demands an id NOW; three in-repo consumers invented three workarounds (mount-gates in chat-supervisor and react-chat-transports; a from-scratch `useCrdtDoc` in the TUI). react-chat-transports' document pane has a **live bug** — a stray empty-paragraph merge artifact — because `native` becomes available before the catch-up snapshot and no readiness signal exists to sequence the editor mount.
- A denied/absent doc open is **invisible**: `DocHandle.ready` rejects, `useDoc` never touches it, there is no `error` field.
- Every chat app hand-builds `chatClient(client, { userId })` + close-effect + rebuild-on-reauth — the exact bridge ADR-0020 abolished for the base hooks, still mandatory for chat (the docs even assign it as a chore).
- The ~20-line `LiveRowSet`→`useSyncExternalStore` glue exists four times (react's own `useCollection`, two example `useLiveRows`, control-center's `useInspectorCollection`).
- No one-shot read exists anywhere client-side; the inspector's private `queryCollection` proves the need and the cheapness.

## Decisions

### D1 — `Register` lives in `@super-line/react`; the factory survives as escape hatch

`@super-line/react` gains the declaration-merged `Register` interface, `RegisteredContract`/`RegisteredRole` types, the unregistered-app guard, and a module-level singleton binding built from one internal `createSuperLineHooks<RegisteredContract, RegisteredRole>()` call. Every re-export uses the **lazy-annotation trick** (explicit indexed-access annotations into a written `Hooks` type, never inference) so `.d.ts` emission does not bake `never` — the mechanism plugin-auth's react.tsx already proves.

```ts
declare module '@super-line/react' {            // the ONE augmentation an app writes
  interface Register { contract: typeof app; role: 'user' }
}
```

Module-level exports: `SuperLineProvider` (props `{ client: SuperLineClient<RC, RR> | null; children? }`), `useClient`, `useMaybeClient`, `useEvent`, `useSubscription`, `useRequest` (unified TanStack-style — D6), `useDoc` (D3/D4), `useCollection` (D4), `useEnv` — plus the context-free `useLiveQuery` (D8). `createSuperLineHooks` remains exported, unchanged in role: the escape hatch for multi-contract apps and tests. Its returned surface gains the upgrades too (single implementation; the module level is just instance #0).

**Footgun carried from ADR-0020's rejection note:** a factory instance is a *separate world* (own context). An app either registers (and uses the module-level surface end to end) or owns a factory instance end to end (its `Provider` + its hooks). Mixing — registered provider, factory hooks — yields silently-empty hooks. Documented in the how-to; the guard cannot catch it.

**Library-author caveat carries over verbatim:** `Register` is global augmentation; packages must keep it in a source-only ambient file their dts build does not emit.

### D2 — plugin-auth/react shrinks to auth-only; **no compat re-exports** (breaking)

`@super-line/plugin-auth/react` exports exactly: `SuperLineAuthProvider` (now feeding the **shared** context via `@super-line/react`'s singleton provider instead of a private factory instance), `useAuth`, and the types re-exported from `./client.js`. Its `Register`, `RegisteredContract`/`RegisteredRole`, and every data-hook re-export (`useClient`/`useEvent`/`useSubscription`/`useRequest`/`useDoc`/`useCollection`/`useEnv`) are **removed** — the user chose the clean break over deprecated aliases. Migration is mechanical (§ Migration).

ADR-0020's session-lifecycle decisions (§1–§3: credential source, never-destroy-what-you-can't-replace, `pending`) stand untouched; only §4's *placement* of the surface is superseded.

### D3 — `useDoc` accepts lazy ids: `string | null | undefined | resolver`, plus `deps`

```ts
type DocId = string | null | undefined
function useDoc<N extends CrdtCollectionName<C>>(
  name: N,
  id: DocId | (() => DocId | Promise<DocId>),
  deps?: readonly unknown[],
): DocState<DocOf<C, N>>
```

- `null`/`undefined` = **idle** (no open, `data` undefined, `ready` false) — plugin-chat's convention, adopted.
- A function is a **resolver**, re-run when `[client, name, ...deps]` change (`deps` defaults `[]`; ignored for the string form, where the string itself is the dependency). Inline arrows are safe by construction.
- Resolution is token-guarded: a result landing after a newer run (or unmount) is discarded without opening. Resolver returning null/undefined → idle; throwing/rejecting → `error`, idle otherwise.

### D4 — Hooks expose readiness, errors, and their underlying handles

```ts
interface DocState<Doc> {
  data: Doc | undefined
  deleted: boolean
  ready: boolean                     // catch-up snapshot applied; false while idle/resolving/loading
  error: unknown                     // open denial / absent doc / resolver failure; cleared on re-open
  handle: DocHandle<Doc> | undefined // reactive VALUE (undefined while idle) — safe as a dependency
  native: unknown                    // unchanged semantics (engine doc, identity-stable across merges)
  set(value: Doc): void
  update(partial: Partial<Doc>): void
  delete(path: (string | number)[]): void
}

function useCollection<N extends CollectionName<C>>(
  name: N,
  query?: CollectionQuery | null,    // NEW: explicit null = idle (undefined stays "whole collection")
): {
  rows: RowOf<C, N>[]
  ready: boolean                     // initial snapshot applied; false while idle
  error?: unknown
  insert(row: RowOf<C, N>): Promise<void>
  update(row: RowOf<C, N>): Promise<void>
  delete(id: string): Promise<void>
  batch(ops: CollectionBatchOp<RowOf<C, N>>[]): Promise<void>   // NEW — parity with CollectionHandle
  handle: CollectionHandle<RowOf<C, N>> | undefined             // NEW
  sub: LiveRowSet<RowOf<C, N>> | undefined                      // NEW
}
```

`ready` is derived from the promises that already exist (`DocHandle.ready`, `LiveRowSet.ready`); a `ready` **rejection** lands in `error` — killing the invisible-denial defect. Exposed handles are windows, not ownership: the hook still closes them on unmount/re-key; callers must not call `close()` (documented).

### D5 — One-shot read: `CollectionHandle.query()` by composition

```ts
interface CollectionHandle<Row> {
  query(q?: CollectionQuery): Promise<Row[]>   // NEW: subscribe → await ready → rows() → close
  // …existing members unchanged
}
```

Client-side composition only — zero wire/server change (`orderBy`/`limit` already shape the initial snapshot, which is exactly what a one-shot wants). Rejects on denial like `subscribe().ready`. Rows only; CRDT docs stay open-by-id.

### D6 — `useRequest` becomes the one TanStack-style request hook (breaking)

Reversal of the earlier separate-`useQuery` lean, at the user's steer: one hook, auto-fetch by default,
programmatic control via options — no second name to learn, and no `useRow` needed at all (see D7).

```ts
function useRequest<M extends keyof Requests<C, R>>(
  method: M,
  input?: ClientInput<Requests<C, R>[M]>,          // required by the overload iff the method needs input to auto-fetch
  opts?: { enabled?: boolean },                     // false = never auto-fetch (the user's "doNotFetchInitially", positively named à la TanStack)
): {
  data?: Output<Requests<C, R>[M]>
  error?: unknown
  loading: boolean                                  // RENAMED from isLoading — matches plugin-chat's existing `loading`
  refetch(): Promise<Output<Requests<C, R>[M]>>     // re-runs with the hook's input
  call(input: ClientInput<…>): Promise<Output<…>>   // manual invocation with explicit input (mutations)
}
```

- **Auto-fetches** on mount, when the JSON-stable serialization of `input` changes, and when the client
  swaps (new session ⇒ refresh) — iff an input was supplied (or the method takes none) and `enabled !== false`.
- **Mutation usage** = omit `input` on an input-requiring method: nothing auto-fires, `call(input)` is
  the imperative path (today's behavior, unchanged). Void-input methods that must not auto-fire pass
  `{ enabled: false }`.
- Last-call-wins state, as today. **Breaking**: `isLoading` → `loading`, and void-input call sites that
  relied on manual-only semantics now auto-fetch unless disabled.

### D7 — no `useRow`: the sugar is unnecessary

Eliminated (user's call, replacing the charted `useRow`). The two things it would have done are already
one-liners: a one-shot single read is `useRequest`/`query()` territory, and a **live** single row is
`useCollection(name, { filter: eq('userId', id), limit: 1 })` — the app declared the key field in its own
contract, so asking the library to echo the field name back (the dropped `key` on `CollectionHandle`) buys
nothing. `rows[0]` is the row.

### D8 — `useLiveQuery`: the shared low-level primitive

```ts
export function useLiveQuery<Row>(
  make: (() => LiveRowSet<Row>) | null,            // null = idle
  deps: readonly unknown[],
): { rows: Row[]; ready: boolean; error?: unknown }
```

Context-free (no contract/role types), factory+deps shaped — the store lifecycle lives in a committed
effect (plugin-chat's `useStoreRows` pattern, StrictMode-proof). Named row-free at the user's pick (the
doc-comment names `LiveRowSet`, so grep-findability survives; the near-collision with TanStack DB's
live-query vocabulary was weighed and accepted). `useCollection` consumes it internally; control-center
and the example `useLiveRows` copies can adopt it (control-center's adoption is decided when the
primitive exists — map fog, not this PLAN).

### D9 — plugin-chat/react goes module-level with an **auto-building ChatProvider**

Module-level exports typed off the shared `Register` (`ReturnType<typeof createChatHooks<RegisteredContract>>` indexed-access annotations): `ChatProvider`, `useChat`, `useChannels`, `useMembers`, `useMessages`, `useMessageParts`, `useMe`, `useChannelBusy`, `useChatHistory`, `useChannelResources`, `useResourcePresence`. `createChatHooks` survives unchanged as the escape hatch.

```tsx
<ChatProvider>                                     // the whole story for an authed app
// props: { chat?: ChatClient<RegisteredContract>; children? } & ChatClientOptions
```

- **No `chat` prop (the default): the provider builds its own** — it reads the shared client from `@super-line/react`'s context, builds `chatClient(client, options)` in a committed effect, closes it on client swap/unmount, and rebuilds when the context client changes (session replacement propagates with no app code). `userId` resolves via chatClient's existing omit-→-`whoami` path — zero coupling to plugin-auth's react half; `ChatClientOptions` (`userId` override, `messageLimit`, `presenceTimeoutMs`) pass through as props.
- **`chat={instance}` = full control**: the provider adopts and never closes it (mirrors `SuperLineAuthProvider`'s adopt semantics).
- Null tolerance: no shared client (pre-auth) ⇒ no ChatClient ⇒ module-level `useChat(): ChatClient<RC> | null` returns null and the row-hooks idle — the factory's throwing `useChat` is unchanged, only the module-level export is maybe-style, matching `useMaybeClient`'s role.
- New optional peer: `@super-line/plugin-chat` → `@super-line/react` (minimum = the minor shipping D1).

### D10 — StrictMode story is designed in its own ticket

Deliberately not specified here (wayfinder ticket "Design the StrictMode story", HITL). Constraint this PLAN imposes: `SuperLineProvider`/`SuperLineAuthProvider`/`ChatProvider` must stay compatible with whatever it decides — all client construction/teardown introduced by this PLAN lives in committed effects, never render.

## Build order

Matches the map's tickets: module-level binding (T02) → hook upgrades (T03) · one-shot query (T04, parallel) → plugin-auth rewire (T05) → plugin-chat module-level (T06) · StrictMode (T07, after T02) → example migrations (T08/T09) → docs + skills (T10) → release wave (T11). Gates per repo norms: root `pnpm typecheck` + `pnpm test` + `pnpm lint`; React-19 examples checked by hand; `skills/super-line/` all four files before any surface is called done.

## Migration (the breaking half, mechanical)

1. Move the augmentation: `declare module '@super-line/plugin-auth/react'` → `declare module '@super-line/react'` (same `{ contract, role }` body).
2. Rewrite data-hook imports from `'@super-line/plugin-auth/react'` → `'@super-line/react'` (`useAuth`/`SuperLineAuthProvider` imports stay).
3. Chat apps: delete the `useMemo(() => chatClient(client, { userId }))` + close-effect + `<ChatProvider chat={…}>` dance → bare `<ChatProvider>`; import chat hooks from `'@super-line/plugin-chat/react'` module-level instead of a local `createChatHooks` file.

External consumer to notify: Omma's tomorrow host (declares the plugin-auth `Register` today). The exact diff to send is drafted when the plugin-auth ticket resolves.

**Constraint discovered during the binding build (2026-07-30): one `Register` per TypeScript program.**
Root typecheck is a single program (`tsconfig.json` includes `packages/*/{src,test}` + `examples/*/src`),
and a second `declare module '@super-line/react' { interface Register … }` in the same program is an
interface merge conflict. Consequences: the three root-EXCLUDED React-19 examples can each register
(own programs); the ten root-typechecked examples **cannot all migrate to Register** — the
factory-examples migration must either keep them on the factory (labeling them the factory showcase) or
move the migrated ones out of the root program. `packages/react/test/hooks.test.ts` carries a
compile-time tripwire asserting the root program stays unregistered.

## Versions (draft bump map; verify at release ticket)

| package | change | bump |
|---|---|---|
| `@super-line/react` | **breaking** (`useRequest` auto-fetches by default, `isLoading` → `loading`) + additive (Register, SuperLineProvider, useLiveQuery, widened useDoc/useCollection) | minor (pre-1.0 breaking convention) |
| `@super-line/client` | additive (`query()`) | minor |
| `@super-line/plugin-auth` | **breaking** (react subpath: Register + re-exports removed); react peer minimum rises | minor (pre-1.0 breaking convention) |
| `@super-line/plugin-chat` | additive react surface; new optional peer `@super-line/react` | minor |
| core / server | untouched | — |

## Out of scope (recorded on the map)

Keep-previous-rows on query change · Suspense/React-19 `use()` · TanStack DB adapter · devtools-extension · **library-wide de-row-ing** (the user dislikes the "row" vocabulary — `RowOf`, `rows()`, `LiveRowSet`, "row collections" — but renaming published API is a breaking sweep chartered as its own future effort; THIS effort only names its new surfaces row-free where a good name exists, hence `useLiveQuery`).
