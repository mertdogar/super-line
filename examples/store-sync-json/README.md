# store-sync · JSON

A collaborative JSON editor showcasing [`@super-line/store-sync`](../../packages/store-sync) — the CRDT
Store backed by [super-store](https://github.com/mertdogar/super-store) (Yjs) — with
[visual-json](https://visual-json.dev) rendering and editing the live document.

Every tab opens the same Store Resource (`plan`). Edit a field and it appears in the other tabs; two
people editing **different** fields at the same time both keep their changes (CRDT merge — where a
last-writer-wins store would clobber one). The **Server nudge** button shows the server itself as a
co-writer.

```bash
pnpm --filter @super-line/example-store-sync-json dev
# open http://localhost:5273 in two tabs (try ?name=ada and ?name=bob)
```

## How it works

- **Server** (`src/server.ts`): `stores: { docs: syncStoreServer() }`, seeds the `plan` Resource, and
  grants every connection read+write in `onConnection` (open join; the Store is deny-by-default). The
  `nudge` request co-writes a field with `srv.store('docs').write(...)`.
- **Client** (`src/App.tsx`): `useResource('docs', 'plan')` gives the live `data` + `set`. `visual-json`
  is a controlled component — its `onChange` hands back the full new value, which goes straight to
  `set(...)`; super-store diffs it into a minimal CRDT delta that fans out to every tab.

## Notes

- Merge is granular at **top-level keys and arrays**; a plain nested object is stored opaquely, so
  concurrent edits to two fields *inside the same nested object* can clobber, while edits to different
  top-level keys always converge.
- Swap `syncStoreServer()`/`syncStoreClient()` for `memoryStoreServer()`/`memoryStoreClient()`
  (`@super-line/store-memory`) to see the same UI with last-writer-wins instead of CRDT merge.
