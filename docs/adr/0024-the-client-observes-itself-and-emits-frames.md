# ADR-0024: The client observes itself, and emits frames rather than the inspector's taxonomy

- Status: Accepted
- Date: 2026-07-28

## Context

super-line already ships an observer. `inspector()` taps every server emit site, snapshots and
redacts the payloads, fans them cluster-wide over its own plugin channel, and the Control Center
renders them. So when the ask is "visualise the client's messages", the cheapest answer is to
render that same feed somewhere new — and it is the wrong one.

The inspector is positioned at the server, and its taxonomy is written in the server's terms:
`connId`, `role`, `target`, `nodeId`, `originNodeId`. A client possesses none of them. The
sharper problem is that the questions a client developer actually has are about things that
never reach the wire at all, and therefore cannot reach a server-side observer at any price:

- a request created but never sent, because the socket was not writable
- how long the current reconnect will wait, and which attempt it is on
- which of several live subscriptions a delivered row was routed into, and which re-filtered it away
- an inbound payload that failed contract validation on arrival and was dropped
- an event delivered to zero listeners — a silent bug with no server-side symptom whatsoever
- which of several concurrently-live clients the page is running (a session replacement
  deliberately runs the incumbent and the candidate at the same time, per ADR-0020)

`SuperLineClientPlugin` had a slot reserved for exactly this — `onEvent?: (event: TapEvent) => void`,
carrying the comment "Type-reserved for a client-side tap; NOT instrumented in v1" — and it was
reserved at the *server's* type, which is the assumption this ADR overturns.

## Decision

**Client-side observation is a client plugin, and it emits wire frames plus client-local
decisions — not a client-shaped copy of `InspectorEvent`.**

The reserved slot is instrumented, retyped to `ClientTapEvent`, and **renamed to
`onClientSideEvent`**. The rename is the point: a plugin author writing both halves of a pair
would otherwise read two identically-named hooks as carrying the same union, and after this they
do not. The interface name already says "Client", so the redundancy is deliberate — it buys an
asymmetry that is impossible to miss in review, where types do not help.

The taxonomy has two kinds. A `frame` variant carries the wire frame verbatim with a direction
and a byte count; a small union covers what the wire cannot show (pending/timed-out/dropped
requests, delivery listener counts, validation failures, per-subscription routing decisions,
connection retry with attempt and delay, CRDT merge versus echo-skip). Re-encoding
`{t:'req', i, m, d}` as `{type:'msg.request', name, input, reqId}` was rejected as a lossy rename
that additionally obliges every future wire frame to grow a matching tap variant.
**Correlation is the observer's job, not the emit site's**: pairing a response to its request and
timing it are things a reader does, and doing them in the client would mean holding per-request
state purely for observation.

Three other sources for the panel's data were weighed:

- **Monkey-patch `WebSocket` in the page.** No library change at all — but it sees only the
  WebSocket transport, only encoded bytes, and none of the client-local decisions above, which
  are the entire reason the panel exists.
- **An ambient hook installed by the extension** (`__SUPER_LINE_DEVTOOLS_HOOK__`, React DevTools'
  pattern), letting the client self-register with no app configuration at all. Rejected in favour
  of an explicit `plugins: [devtoolsPlugin()]`: an observer that attaches itself to whatever page
  it finds is a broader ambient surface than one the app names, and the convenience it buys is a
  rebuild the developer was already doing.
- **Dial the inspector channel from the panel.** Needs `inspector: true` on the server, reports
  the server's truth rather than this tab's, and duplicates an app that already ships.

## Consequences

Payloads are snapshotted eagerly at emit rather than held by reference. This is not defensive
style: the panel's zero-permission channel is `chrome.devtools.inspectedWindow.eval`, which
throws unless the drained value is JSON-compliant, so one `Map` or one cycle in a single payload
would fail an entire batch instead of degrading one row. `safeSnapshot` therefore moves out of
`inspector()`'s closure into core, and both observers share one implementation.

The panel **polls and pushes**, which reads like redundancy and is not. Polling through `eval`
requires no permissions at all, so the extension installs with no warnings and works immediately;
push requires an injected relay and a host permission, so it is an opt-in upgrade granted per
origin on a user gesture. They are not two sources of truth — every event carries a monotonic
`seq`, a pushed event at or below the panel's cursor is ignored, and a gap re-drains. Polling
stays authoritative for repair, so the push path can fail or be declined without losing data.

The cost accepted in exchange: the client now pays a bounded snapshot walk per event whenever a
tap is registered, where the server's tap pays nothing until a plugin subscribes. Guarding
emission on there being at least one tap keeps the un-plugged cost at one boolean check, but a
registered tap is not free the way the server's is, and it cannot be — the JSON-compliance
requirement is upstream of the choice.

`ClientTapEvent` is the widest new surface introduced here and the hardest to change later: the
panel binds to it, and so will anything else that ever taps a client.
