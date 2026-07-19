# ADR-0013: plugin-chat host schemas bridge through Standard Schema

**Status:** accepted (2026-07-19) · **Builds on:** ADR-0011 · **Prompted by:** the OMMA 0.5.0
adoption findings (finding 2)

## Context

`chatContract({ content, data })` parameterizes the message body and the data-part payload with a
host-supplied schema. Through 0.5.0 those slots were **embedded directly into plugin-chat's own zod
tree** (`messagePartBaseSchema.extend({ type: literal('data'), data })`), which silently required
the host's schema to be produced by **the exact zod instance plugin-chat resolves**. Two verified
failure modes:

- **Runtime:** a zod-4 (or any foreign-copy) schema inside the zod-3 tree throws
  `keyValidator._parse is not a function` on first validation.
- **Type-level:** even a v3-classic schema from a *different copy* (zod 4's `zod/v3` compat export,
  a separately-resolved zod 3) explodes with `TS2589: Type instantiation is excessively deep` —
  structurally comparing two zod copies' generics never converges.

The only host-side fix was an aliased dependency pinned to whatever our floating `^3.24.1`
resolves — fragile by construction. Meanwhile core's public promise is "any Standard Schema
validator" (`Schema = StandardSchemaV1`, `contract.ts`); these two slots were the sole exception.

## Decision

`content`/`data` slots accept **any `StandardSchemaV1`** (`messageSchema`, `messagePartSchema`,
`streamEventSchema`, `requestDefs`, `chatContract`, `chatAgentTools` — all constrained on core's
`Schema`, inferring via `InferOut`). The envelope stays in plugin-chat's own zod; a host slot is
wrapped by `hostSchema()`:

- A schema from **plugin-chat's own zod instance passes through untouched** — zod error detail,
  typed-table column planning, and LLM-facing JSON-schema quality are preserved for the common case.
- Anything else is validated through its `~standard.validate` inside a `z.unknown().transform()`
  bridge: value-replacing (host transforms/defaults apply), issues spliced into the zod issue list
  under the slot's path. **Sync validators only** — an async `~standard.validate` throws a
  descriptive `TypeError` (the surrounding row/request tree parses synchronously).

## Consequences

- The README promise now holds everywhere; the zod version is a private implementation detail of
  plugin-chat. Hosts on zod 4, Valibot, or ArkType work with no pin.
- Typed-table planning is unaffected: the parts schema is a top-level discriminated union (already
  `_sl_data`-degenerate), and the messages envelope remains a real ZodObject.
- A *foreign* validator embedded in `chatAgentTools` renders as an opaque slot in the model-facing
  JSON schema (the server still validates every send); a plugin-chat-zod schema keeps rich guidance.
- Rejected: documenting the same-instance pin (leaves the promise broken, breaks on every zod
  version drift) and making zod a peerDependency (cannot serve a zod-4 host and a `^3` peer range
  simultaneously).
