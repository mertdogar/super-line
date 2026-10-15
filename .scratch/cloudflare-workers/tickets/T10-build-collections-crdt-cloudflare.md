---
id: T10
title: Build @super-line/collections-crdt-cloudflare (CRDT docs on DO SQLite)
labels: [wayfinder:task]
status: closed
assignee: claude session 2026-10-15 (T10)
blocked-by: [T09]
---

## Question

The `CrdtCollectionStore` backend on DO SQLite, relay mode, snapshot-per-doc like `collections-crdt-libsql` unless T05 locked otherwise; validate-before-commit at ingress as every CRDT backend does. Conformance tests in the workers lane.

> From T09: DO storage is bound to its object — run conformance inside `runInDurableObject` with `aroundEach` and a fresh `env.STORE` object per test (pattern + `StoreNode` binding in `test-workers/collections-cloudflare.workers.test.ts`). Same lazy-open / per-collection-failure stance as the rows backend, so nothing throws in the constructor. `AppNode` already hosts a rows backend; add a CRDT collection there for the end-to-end wake test.

## Resolution

**Built.** `@super-line/collections-crdt-cloudflare` 0.1.0 (unreleased): `crdtCloudflareCollections(ctx.storage, contract.collections, { debounceMs? })` → a relay `CrdtCollectionStore` wrapping `crdtMemoryCollections`'s Yjs engine, one `_sl_crdt (collection, id, state BLOB, created_at, updated_at)` row per doc. ESM-only; peers core `>=0.20.0` + collections-crdt-memory `>=0.3.0` (the floors that have the optional-validate fold skip); `@logtape/logtape` dep; checked by its own tsconfig inside `pnpm typecheck`.

Calls made while building (detail in PLAN-cloudflare "As built (T10)"):
- **Lazy per-doc load**, not libsql's rehydrate-all — that would run on every wake. Synchronous (DO SQL is), so `apply` stays sync. The replay is hidden from `onChange`, so a wake doesn't re-broadcast whole docs to adopted connections (mutation-checked).
- Takes the contract's `collections` map (not a `docOptions` callback): `read` gets no `DocOptions`, so the factory looks them up.
- **Debounce 250 ms kept** as locked: write-through per edit would re-add the per-keystroke full encode that `crdt.validate: false` removes. Timer holds the object awake for the window; only a forced reset loses it.
- `list` answered from storage → `createdAt` survives wakes, listing loads nothing.
- **2 MB**: local workerd does NOT enforce the row limit (probe: a 5 MB BLOB inserted). So the backend checks itself: `create` throws a readable `INTERNAL`; an edit that outgrows the row fails its write-through (logged), and later writes to that doc throw the same error while storage keeps the last state that fit.

Tests: new shared **CRDT conformance suite** `packages/collections-crdt-memory/test/crdt-store-conformance.ts` (the memory backend's own tests, extracted; memory now runs through it) + 9 backend tests in `test-workers/collections-crdt-cloudflare.workers.test.ts`, incl. end to end: `AppNode` carries a `boards` CRDT collection + `createBoard` request — an open doc survives a real wake, a post-wake write reaches every holder, a fresh client sees it, zero lifecycle events. Workers 69/69 (was 52), fast 854/854, typecheck + lint clean, package builds (4.7 KB), `check-manifest` passes.

Found, not fixed (outside this ticket):
- **Client bug**: a second `collection(n).open(id)` of a doc the same client already has open resolves `ready` before its replica is seeded (snapshot `{}` at ready, correct a moment later) — `openDoc` reuses the entry's already-settled deferred. Not Cloudflare-specific.
- **Unverified suspicion**: after a forced reset inside the debounce window, the writer's lost edit may leave its later Yjs updates pending on the server (missing clock) until it reopens. Applies to libsql too.

Also: CLAUDE.md (layout, typecheck exclusions), all four `skills/super-line/` files, PLAN-cloudflare "As built (T10)". README is T12's.
