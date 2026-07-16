# ADR-0012: `env` — a server-vended, client-visible per-connection state bag

- Status: Accepted
- Date: 2026-07-17
- Builds on: [ADR-0005](0005-plugins-as-paired-runtime-bundles.md) (paired plugins), the connect-time
  `authenticate` model, and `conn.data` (server-only per-connection state)
- Origin: a `/grill-with-docs` session that started as "make bot auth easier" (see `PLAN-connection-context.md`)

## Context

An AI agent (a bot) and a human share a channel; the server orchestrates the connection. Over the
conversation the agent needs **credentials + config to do its work** — an external API key, a project id, other
real secrets — to call *other* services out-of-band. The server knows, per its own business logic, which creds
a given connection should hold, and may need to update them mid-conversation (rotation, re-scope). super-line
had no way for the server to hand a connected client a typed payload and keep it live.

The ask began as "bot authentication," but bots already authenticate fine (an API key → a fixed role). The
real gap was **credential *delivery* onto a live connection**, not identity. It is emphatically **not**
delegation: super-line does not act for anyone, does not impersonate, and does not evaluate the human's
permissions on the agent's behalf. The agent uses the creds itself, outbound. super-line is a **pure courier**.

## Decision

Add a first-class **`env`** primitive to `@super-line/core`: a **typed, per-connection, server-owned,
client-visible, mutable, ephemeral** state bag. It is the visibility-mirror sibling of the existing
`conn.data`:

|  | **frozen** | **mutable** |
|---|---|---|
| **server-only** | `conn.ctx` (identity, authz input) | `conn.data` (scratch) |
| **client-visible** | *(identity fields the client already knows)* | **`conn.env`** (creds/config) |

- **Declared on the contract** per role (`roles.user.env: <schema>`), sibling to `data`; validated on every
  write; typed end-to-end (`EnvOf<C,R>`).
- **Seeded by `authenticate`**, whose return grows to `{ role, ctx, env }`. `ctx` and `env` are produced by
  one connect-time call but stay separate bags — `ctx` is the frozen, server-only identity that authorization
  keys on; `env` is the mutable, client-visible payload. Because `authenticate` is already awaited at accept,
  the initial `env` frame is delivered before the connection is ready (no race).
- **Updated live** via `conn.setEnv(v)` (node-local) and `srv.toUser(id).setEnv(v)` (cluster-wide, over the
  Adapter like `toUser().disconnect()`), each emitting a full-value `env` server→client frame.
- **Read** on the client as `client.env` (`current` / `ready` / `subscribe`), `useEnv()` in React. **Code-only**
  — the agent's runtime wires the creds into its tool implementations; the LLM never sees the payload.
- **Never persisted** — it holds live secrets and lives only in memory on the connection, re-seeded on
  reconnect. Any durable *authorization* is the host app's concern, not super-line's.
- **Inspectable, masked-by-default** — the Control Center surfaces `env` in `ConnView` and an `env.set`
  live-feed event, but (unlike `ctx`/`data`'s deny-list redaction) `env` values are **masked by default** and
  the host allow-lists safe keys (`revealEnvKeys`), because `env` always holds credentials.

## Considered alternatives

- **A plugin-auth server→client event instead of a core primitive.** Rejected once "don't touch core" was
  lifted (pre-1.0, no users). `env` is *state* with a current value; modeling it as an event forces
  re-implementing "hold latest + seed-on-connect + ready" in the plugin's client half — a simulated-state
  anti-pattern that is *more* code. A core primitive matches the grain.
- **Merging `env` into `ctx`, or dropping `ctx`.** Rejected — they are opposite corners of the
  visibility×mutability grid. Exposing `ctx` would leak its server-only contents (e.g. `sessionId`) and make
  authorization key on a mutable bag. They are paired at the source, not merged.
- **A separate `resolveEnv` core server option.** Rejected as redundant with `authenticate`. (plugin-auth
  keeps a `resolveEnv(ctx)` *kit* option only because `authKit` owns `authenticate` on the host's behalf.)
- **Persisting `env` in a collection (`sessions` or new).** Rejected — persists secrets at rest and, being
  member-readable, leaks them; `env` must be ephemeral and per-connection.
- **On-behalf-of / impersonation authority; per-`(channel, member)` scoping; a bot identity marker.** All
  rejected — see `PLAN-connection-context.md` §9 for the reasoning.

## Consequences

**Gained.** A typed, live, server-controlled way to hand a connection its working credentials, keyed by
connection, usable with or without plugin-auth; secrets never touch disk; full Control Center visibility with
a credential-safe default. The `data`/`env` pair teaches in one sentence ("`data` is your server-side scratch;
`env` is the same, but the client sees it").

**Given up.** Nothing existing — `ctx`/`data` are unchanged. The cost is new surface across core (contract
type, wire frame, client reader), the `AuthOutcome` shape, and the inspector.
