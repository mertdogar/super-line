---
id: T12
title: Docs and skills teach the Cloudflare target
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T11]
---

## Question

Published docs: a how-to for Workers/DO hosting (choose transport, hibernation semantics the user must know, which backends, limits), the backends guide updated, package READMEs for the three new packages, root README/positioning mention. All four `skills/super-line/` files. No ADR/plan citations in any of it. Full `docs:build` green.

> Graduated from fog at T09 — **schema changes on a deployed object**: a non-additive change makes that collection fail its operations (`INTERNAL`, names the collection and the fix) while the rest of the object works; additive optional fields ALTER in. Teach the host the two ways out — rename the collection (new table, old rows orphaned) or migrate `col_<name>` and its `col_meta` row in code before the store opens — plus the limits (98 fields per collection, 2 MB per row, a filter over > 98 values scans in JS). Skills already carry the short form (T09).

> From T10: skills already name `crdtCloudflareCollections`. The how-to should state: docs load on first touch after a wake; edits reach storage 250 ms later (a deploy inside that window loses them; hibernation never does); a doc over 2 MB is refused with a readable error — split big content across docs. README for `collections-crdt-cloudflare`.

> From T11: the how-to needs the deploy gotchas in T11's resolution — route only the socket path (every request wakes the object), the constructor and `onConnection` re-run on every wake, `pnpm run deploy`, strong inspector passwords (query-string log redaction is heuristic), `Unknown Event` in `wrangler tail`. Still unobserved: the platform's error text for a row over 2 MB on a real deploy (the client sees `INTERNAL` either way) — probe it if T12 deploys, otherwise document the ceiling without the text. `examples/cloudflare/README.md` exists; link it.
