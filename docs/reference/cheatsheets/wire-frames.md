---
lastUpdated: false
---

# Wire frames

The frame types super-line puts on the client↔server wire, each tagged by a short `t`. You never write these by hand — the [transport](/concepts/transports-and-adapters) carries them and the client/server SDKs encode and decode them — but they're useful when reading a [Control Center](/how-to/control-center) live feed or debugging a custom transport.

## Client → server

| `t` | Frame | Carries |
| --- | --- | --- |
| `req` | request | a [request](/how-to/requests) call + correlation id |
| `sub` | subscribe | opt into a [topic](/how-to/topics) |
| `unsub` | unsubscribe | drop a topic subscription |
| `sres` | server-request response | the client's reply to a server-request |
| `serr` | server-request error | the client's error reply to a server-request |
| `ping` | keepalive | liveness probe |
| `csub` | collection subscribe | open a [row-set](/collections/row-collections) for a query |
| `cuns` | collection unsubscribe | close a row-set |
| `cbat` | collection batch | an atomic [row write batch](/collections/row-collections) |
| `cdopen` | CRDT open | open a [document](/collections/crdt-documents) by id |
| `cdwr` | CRDT write | a document delta |
| `cdclose` | CRDT close | close a document handle |

## Server → client

| `t` | Frame | Carries |
| --- | --- | --- |
| `res` | response | a request's typed reply |
| `err` | error | a request's [`SuperLineError`](/reference/cheatsheets/errors) |
| `evt` | event | a pushed [event](/how-to/events-rooms) |
| `pub` | publish | a [topic](/how-to/topics) publish to subscribers |
| `sreq` | server-request | the server calling the client, awaiting a reply |
| `pong` | keepalive | reply to `ping` |
| `cchg` | collection change | a row `insert` / `update` / `delete` for a subscribed row-set |
| `cdchg` | CRDT change | a merged document delta |
| `cddel` | CRDT delete | a document was deleted |

Frame shapes are defined in `@super-line/core` (`packages/core/src/wire.ts`) and exported as `PROTOCOL`. See the [API reference](/reference/@super-line/core/) for the exact payloads.
