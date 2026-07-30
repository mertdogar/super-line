# ADR-0026: The React binding is registered once, and plugins feed it

- Status: Accepted
- Date: 2026-07-30 — settled in the react-dx wayfinder charting session
- Supersedes: **§4 of [ADR-0020](0020-auth-owns-the-client-so-it-owns-the-session-lifecycle-and-the-react-surface.md)** ("plugin-auth/react is the React surface") — its §1–§3 (credential source, replacement-never-destroys, `pending`) stand untouched
- Plan: `docs/plans/PLAN-react-dx.md`

## Context

ADR-0020 killed the hand-written bridge between the two React bindings by making plugin-auth the owner
of the module-level, `Register`-typed hook surface. That placement had a shape problem visible within a
month: the **data hooks belong to the base library, but you could only import them module-level from the
auth plugin**. An app without plugin-auth had no registered surface at all (factory-only); an app with it
imported `useCollection` from `@super-line/plugin-auth/react`, a package that owns none of that
machinery. And plugin-chat, which has the *same* two-bindings-that-don't-compose problem ADR-0020 fixed
for auth (every chat app hand-builds `chatClient(client, { userId })` and rebuilds it on reauth), could
not join a Register that lived inside a sibling plugin.

Meanwhile the hooks themselves were missing conveniences that every real consumer hand-rolled:
readiness/error signals (`DocHandle.ready` rejections were silently invisible), lazy doc ids, the
underlying handles, one-shot reads. Those fixes are orthogonal to placement but shipped in the same
effort; they live in the PLAN.

## Decision

**`Register` and the module-level binding live in `@super-line/react`. Providers — plain or
plugin-owned — feed its one shared context; plugins expose only what is theirs.**

- `@super-line/react` owns `Register`, `RegisteredContract`/`RegisteredRole`, the unregistered-app
  guard, `SuperLineProvider`, and module-level exports of every hook, all lazily annotated so `.d.ts`
  emission never bakes `never`. `createSuperLineHooks` survives as the multi-contract escape hatch — an
  instance is a separate world (own context), never a second way to type the registered one.
- `@super-line/plugin-auth/react` exports **auth only** (`SuperLineAuthProvider`, `useAuth`, types).
  The provider keeps ADR-0020's session lifecycle and now feeds the shared context. Its `Register` and
  data-hook re-exports are removed — a clean break, no deprecated aliases.
- `@super-line/plugin-chat/react` gains module-level hooks typed off the same `Register`, and its
  `ChatProvider` **auto-builds** the ChatClient from the shared context (userId via the existing
  omit-→-`whoami` path — no coupling between plugin react-halves), closing and rebuilding it on session
  swap. The manual `chat={…}` prop remains for full control.

The composition rule this settles: **the base package owns the registration point; a plugin's react half
is a feeder/consumer of that one context, never a second home for the surface.**

## Consequences

- **Breaking, concentrated in plugin-auth's react subpath** (pre-1.0): apps move one `declare module`
  line and their data-hook import paths. In-repo examples migrate wholesale; the one known external
  consumer (Omma's tomorrow host) gets an exact diff when the rewire ticket lands.
- An app without any auth plugin now gets the registered ergonomics too (`SuperLineProvider` + direct
  imports), ending the factory-only asymmetry.
- plugin-chat's react half acquires an optional peer on `@super-line/react`.
- The factory/Register coexistence footgun ADR-0020 warned about is narrowed, not gone: mixing a
  registered provider with hooks from a privately-created factory instance still yields silently-empty
  hooks. Documented; not statically preventable.
- `Register` remains global augmentation with ADR-0020's library-author caveat (source-only ambient
  file, never emitted in a package's `.d.ts`).
