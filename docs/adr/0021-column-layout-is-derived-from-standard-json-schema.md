# ADR-0021: Column layout is derived from Standard JSON Schema, not a vendor's classes

- Status: Accepted
- Date: 2026-07-27
- Amends: [ADR-0013](0013-plugin-chat-host-schemas-bridge-through-standard-schema.md) (two of its consequences assumed a foreign validator must render as an opaque slot, and that typed-table planning depends on the envelope "remaining a real ZodObject")
- Plan: `PLAN-collections-typed-tables.md` (Phase 0, `planColumns`)

## Context

`planColumns` derived a collection's SQL column layout by walking the schema with `instanceof`
against Zod 3's classes — `schema instanceof ZodObject`, `t instanceof ZodOptional`, and so on.
That required a value import of `zod` in `packages/core/src/column-plan.ts`.

zod was declared only in core's **devDependencies**. tsup externalises `dependencies` and
`peerDependencies` and bundles everything else, so the published `@super-line/core` shipped **the
entire Zod 3 library inlined into `dist/index.js`** — 43 `ZodObject` references, a full
`ZodFirstPartyTypeKind`, no `import … from "zod"` anywhere. `instanceof ZodObject` therefore
compared a consumer's schema against *core's own private copy of Zod*, which nothing outside the
bundle is ever an instance of.

The consequence was total and silent. Probing the built dist as a consumer would:

```
zod3 (consumer copy)   => degenerate: true | v1:degenerate;key=id;_sl_data:json;id:text
zod4 (zod/v4 subpath)  => degenerate: true | v1:degenerate;key=id;_sl_data:json;id:text
```

**Every** published consumer got the degenerate layout — Zod 3 users included, not just the Zod 4
users whose reports surfaced it. Typed tables worked only inside this monorepo, where tests import
`src` rather than `dist`. Worse, the drift gate persists that layout: `col_meta` recorded
`v1:degenerate;…`, so a later fix would flip the fingerprint non-additively and refuse to boot.

The framing that produced the original design was that Standard Schema is validate-only — it
publishes `~standard.validate` and nothing about shape — so a SQL backend that needs a shape had no
choice but to reach for a vendor's internals. **That is no longer true.**
[Standard JSON Schema](https://standardschema.dev/json-schema) is a shipped companion spec: a
`~standard.jsonSchema` converter with `.input(options)` / `.output(options)`. It ships in
`@standard-schema/spec` — the package core already depended on — from 1.1.0, and is implemented by
Zod 4.2+, Zod Mini 4.2+, ArkType 2.1.28+, VineJS 4.3+, Sury 11+, stnl 2.1+, and Valibot 1.2+ via
`@valibot/to-json-schema`'s `toStandardJsonSchema()`.

## Decision

**Core reads shape through `~standard.jsonSchema`, and imports nothing from any schema library.**

`jsonSchemaOf(schema)` (`packages/core/src/contract.ts`) is the single place super-line asks a
validator for its shape. `planColumns` maps the resulting JSON Schema to columns: `required`
drives `optional`, a `{type:'null'}` branch drives `nullable`, and `type`/`const`/`enum` drive the
storage kind. The type import `StandardJSONSchemaV1` is erased at build, so core ships zero
schema-library code — the bundling failure above is not fixed but made **structurally impossible**,
because there is no dependency left to mis-declare.

Two supporting decisions fall out:

- **`unrepresentable: 'any'` is policy, not a workaround.** Passed via the spec's `libraryOptions`.
  Without it a single `.transform()` anywhere in a schema throws and the *whole* collection
  degenerates; with it that one field converts to `{}` and becomes one JSON column while every
  other field stays typed. Vendors that don't recognise the key ignore it.
- **zod stays a normal `dependency` of the packages that author schemas** (plugin-auth,
  plugin-chat) and is never a peer. A peer would force a Valibot or ArkType user — precisely the
  user Standard Schema exists to serve — to install zod to satisfy it. A normal dependency is safe
  exactly as long as zod never crosses the public API boundary, which is now enforced: no
  `instanceof` on a zod class, and no public signature requiring a *user's* schema to be a zod type.

`scripts/check-manifest.mjs` gained the guard that would have caught this: every bare-specifier
value import in a tsup-built package must appear in `dependencies` or `peerDependencies`. Run
against the pre-fix tree it reports `@super-line/core: src/column-plan.ts value-imports "zod"`.

## Consequences

- Typed tables work for published consumers for the first time. Against the built dist, Zod 4,
  ArkType and Valibot now all produce `degenerate: false` with **byte-identical fingerprints**.
- Core's `dist/index.js` drops from 132K to 20K; the inlined Zod is gone (43 `ZodObject` → 0).
- Every layout fingerprint changes, so the prefix moves `v1` → `v2` deliberately: operators see
  "layout version changed" from the drift gate rather than a baffling column-by-column diff.
- **Amends ADR-0013.** A foreign validator no longer "renders as an opaque slot" — `hostSchema`
  carries the host's JSON Schema through as `.meta()`, so Zod, ArkType and Valibot give the model
  and the column planner the same guidance. And planning no longer depends on the envelope "being a
  real ZodObject"; it depends only on the envelope reporting a shape. 0013's *decision* — bridge
  host schemas through Standard Schema rather than pinning a zod instance — is unchanged and now
  rests on a mechanism that actually delivers it.
- ADR-0008 is **not** amended. Its claim is that core cannot derive a presence-tolerant *variant*
  of a validator; reading a shape does not let you construct a modified validator, and
  reconstructing one would silently drop refinements and transforms. Only the schema author can
  express presence-tolerance, exactly as 0008 concluded.
- A library that has not implemented the companion spec degrades to `key + _sl_data` — the same
  fallback as before, but now reached only when genuinely warranted instead of always.

## Rejected

- **Making zod a `peerDependency` of core and keeping `instanceof`.** The smallest diff, and it
  does stop the bundling. But it makes zod mandatory for every super-line user including browser
  clients that never touch collections, and it re-breaks the moment two zod copies coexist.
- **Duck-typing `_zod.def.type` / `_def.typeName`.** Correct and dependency-free, and it was the
  plan until Standard JSON Schema was found. It only ever serves zod; every other vendor still
  degrades to a blob.
- **An introspector seam with per-vendor adapters** (`@super-line/introspect-zod`, …). The
  companion spec makes the vendors implement the seam themselves; shipping our own registry would
  duplicate it with worse coverage.
- **Declaring columns on the contract** and using the schema only to validate (the TanStack Form
  position — it never introspects, because the form declares its own fields). Genuinely immune to
  all of this, but it duplicates the row shape with nothing to keep the two halves honest.
- **Round-tripping the host schema through JSON Schema back into zod** so it composes natively.
  `standard-json` converts only one way, zod has no `fromJSONSchema`, and the reconstruction would
  become the thing that *validates* — silently dropping refinements, transforms and brands, so a
  value failing the host's real validation would be accepted.
