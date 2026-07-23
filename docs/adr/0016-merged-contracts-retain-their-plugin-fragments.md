# Merged contracts retain their plugin fragments

`defineContract({ plugins: [...] })` merged each fragment's collections and surface keys into one flat contract and then **discarded the plugin list**, so nothing downstream could tell which plugin contributed what — the inspector's `getContract` returned two dozen `shared` requests from two different plugins as an undifferentiated wall, and the Control Center had to guess at a plugin's presence by sniffing collection names. The merged contract now keeps `plugins` (the `ContractPlugin[]` it was given), `ResolveContract` no longer omits it from the resulting type, and the inspector projects it onto the wire as per-plugin key lists.

## Considered Options

- **A reverse index in core** (`{ collections: { users: 'auth' }, … }`) — exactly what a badge lookup wants, but a second representation of information core already holds, invented solely for one consumer.
- **Derived per-plugin key lists in core** — same objection, one shape further from the source.
- **Runtime plugin names only**, exposed on `PluginContext` with no contract change — cheap, but answers "is it installed" and never "what does it own".

Retaining the fragments keeps the truth at its source and leaves projection to the inspector, which already exists to project the raw contract into a serializable view. The runtime plugin list ships *as well*, because the two halves genuinely differ (see [[Plugin provenance]]).

## Consequences

- The merged contract is no longer a purely normalized product: it holds references to the fragment objects and their live schemas for the process lifetime. Nothing walks a contract generically (`classifyContract` visits only `shared`/`roles`), so this is inert — but a future generic walk must not assume otherwise.
- `Contract` and the resolved contract type both widen. Structurally non-breaking, but it is a public `@super-line/core` type change.
- The server can now see which contract fragments were merged, making "plugin registered but fragment never merged" (and the reverse) a detectable misconfiguration rather than a runtime `NOT_FOUND` with no explanation.
