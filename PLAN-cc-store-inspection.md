# PLAN — Store-value inspection in the Control Center

Browse current Store values from the Control Center (a new **Stores** explorer tab) and enrich
the existing Live Feed so a `store.*` row can reveal the resource's current value. **Read-only.**

## Why this shape

- Store *activity* is already inspectable: the inspector emits `store.write/grant/revoke/subscribe/unsubscribe`
  and the Live Feed has a "Stores" filter. What's missing is the **current value** of a resource.
- There's an **enumeration gap**: stores are a static `Record<string, ServerStore>` (`storeMap`); there is
  no client wire path to list store names or resource ids. So enumeration RPCs must be invented regardless.
- The **CRDT sync store is opaque on the wire**: `read(id).data` and the `store.write` event's `data` are
  base64 Yjs state/deltas. Only `open(id).getSnapshot()` materializes a readable JS value (and it returns
  plain data for LWW too). So the server must materialize via `getSnapshot()` and ship plain JSON — that
  keeps the generic, app-agnostic Control Center from needing to bundle/know each store's client backend.

## Server side — `packages/core`, `packages/server`, store backends

1. **New optional field on `ServerStore`** (`core/src/store.ts`): `readonly model?: 'lww' | 'crdt'`.
   Set in `store-memory` (`'lww'`), `store-sqlite` (`'lww'`), `store-sync` (`'crdt'`). Optional so custom
   backends that omit it simply render no badge.

2. **Three new inspector RPCs** in `InspectorContract` (`core/src/inspector.ts`), handled in
   `server/src/index.ts` `inspectorHandlers`:
   - `listStores()` → `{ name: string; model?: 'lww' | 'crdt' }[]` (from `Object.keys(storeMap)`).
     No `count` — the resource-id list is fetched on selection via `listResources`.
   - `listResources(store)` → `string[]` (backend `list()`).
   - `readResource(store, id)` → `{ data: unknown; accessRules: AccessRules }`.

3. **Materialization in `readResource`**: `store.open?.(id)` → `getSnapshot()` → `close()`; **fallback to
   `read(id).data`** when `open` is absent. Uniform readable JSON for LWW and CRDT.

4. **Visibility**: ignores ACL entirely (trusted observer). Value passed through `safeSnapshot()` for
   serialization safety only — **no `redact` masking**. `accessRules` returned as plain data.

5. **Two new `InspectorEvent` types** (`core/src/inspector.ts`): `store.create { store, id }` and
   `store.delete { store, id }`, emitted from the server create/delete paths (and the client-driven create),
   for live list discovery. Existing store events cover the rest.

## Control Center — `packages/control-center`

6. **New "Stores" tab**: App.tsx `View` union + `NAV` entry + conditional render. Layout: left = store list
   (name, model badge, count) → resource id list → value panel (pretty JSON) + accessRules.
   Add `listStores`/`listResources`/`readResource` to `InspectorClient` (`lib/inspector-client.ts`).

7. **Liveness (pull-and-refresh, no polling, no per-resource subscription)**:
   - on `store.create`/`store.delete` → re-fetch the resource list for that namespace;
   - on `store.write`/`store.grant`/`store.revoke` for the *viewed* resource → re-call `readResource`.

8. **Feed enrichment**: expanding a `store.write` row shows the value directly from the event `data`
   (for LWW it already IS the full new value); call `readResource` to materialize only when the store's
   `model === 'crdt'` (the event `data` is an opaque Yjs delta there). Wire helpers in `lib/events.ts`.

## Out of scope

- No editing/writes from the Control Center (pure observer).
- No live resource-channel subscription; no client-side store-model awareness (server materializes).
- No `inspector.redact` masking of store values (full visibility by request).
