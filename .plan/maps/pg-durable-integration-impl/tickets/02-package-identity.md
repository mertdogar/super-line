---
type: grilling
blocked_by: []
---
# Package identity: name, subpaths, platform statement

## Question

Decide with Mert before scaffolding:

- **Name** — `@super-line/plugin-workflows`? `plugin-durable`? Something else?
  It's the paired-plugin family (queue/auth/chat), so `plugin-*` is presumed.
- **Subpath shape** — auth/chat ship `.` (contract) · `/server` · `/client` ·
  `/react`; queue ships one entry. The kit's client story is thin v1 (the
  `workflowRuns` collection + host-owned requests) — does it need `/client` at
  all yet, or does one entry + contract suffice until a consumer shapes it?
- **Factory name** — `workflows()` (kit like `queue()`/`auth()`/`chat()`)?
- **Platform statement** — duroxide is a napi native dep with no linux-arm64
  binary yet: what does the package README promise, and does the kit refuse or
  warn on unsupported platforms?
- **Version/privacy posture pre-gate** — `private: true` vs publishable-shape
  0.0.x; confirm private until the graduation gate.

## Done when

All five recorded; the scaffold ticket can start without further questions.

## Answer
