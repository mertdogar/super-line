---
lastUpdated: false
---

# Server & client options

The common options for `createSuperLineServer(contract, options)` and `createSuperLineClient(contract, options)`. The **authoritative, exhaustive** set is generated from source — see [`@super-line/server`](/reference/@super-line/server/) and [`@super-line/client`](/reference/@super-line/client/).

## Server — `createSuperLineServer`

| Option | Required | What it does |
| --- | :---: | --- |
| `transports` | ✓ | the client↔server [wire(s)](/how-to/choose-a-transport) the server accepts |
| `authenticate` | ✓ | runs once per connection; returns `{ role, ctx }` (throw to reject at handshake) — see [Roles & auth](/how-to/roles-auth) |
| `identify` | | map a connection to a stable user id (for [presence](/how-to/introspection-and-presence) + `toUser`) |
| `serializer` | | custom wire codec — see [Serialization](/how-to/serialization) |
| `adapter` | | server↔server [fan-out](/how-to/choose-an-adapter) for multi-node (in-memory by default) |
| `nodeName` | | a friendly node label surfaced in [Control Center](/how-to/control-center) |
| `collections` | | the [row-collection backend](/collections/backends) (one per server) |
| `crdtCollections` | | the [CRDT document backend](/collections/backends#crdt-backends) |
| `policies` | | per-collection [read/write policies](/collections/policies) (deny-by-default) |
| `checkReferences` | | opt into [advisory FK](/collections/policies#advisory-foreign-keys) existence checks |
| `onConnection` | | a per-connection hook (`(conn, ctx) => void`) |

> The inspector is now a [plugin](/concepts/plugins) (`@super-line/plugin-inspector`), not a server option — add it via `plugins: [...]`.

## Client — `createSuperLineClient`

| Option | Required | What it does |
| --- | :---: | --- |
| `transport` | ✓ | the client [wire](/how-to/choose-a-transport) (the only line that changes between wires) |
| `role` | ✓ | narrows the surface to `shared ∪ role`; verified by the server's `authenticate` |
| `params` | | handshake params, readable server-side as `h.query.*` |
| `crdtCollections` | | the universal [CRDT client engine](/collections/crdt-documents#client-open-a-document) (`crdtCollectionsClient()`) |
| `serializer` | | a codec matching the server's — see [Serialization](/how-to/serialization) |

See the [API reference](/reference/) for every option and its exact type.
