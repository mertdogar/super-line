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

Resolved 2026-08-07 with Mert, all five settled:

1. **Name: `@super-line/plugin-workflows`** — names the capability, not the
   engine; survives an engine change.
2. **Surface: one entry, plugin-queue-style** — `workflows({...})` returns the
   kit with `.contract` / `.plugin` plus the trusted server surface. No
   `/client` or `/react` subpaths until a consumer shapes them (stays in the
   map's fog).
3. **Factory: `workflows()`** — noun symmetry with `queue()`/`auth()`/`chat()`.
4. **Platforms: document + wrap.** README states duroxide's prebuilt matrix
   (darwin x64/arm64, linux x64, win x64; linux-arm64 pending upstream) and the
   kit catches the native-module load failure, rethrowing with a clear message
   naming the platform and the upstream gap. No platform-sniffing table.
5. **Pre-gate posture: `private: true`**, version 0.0.0, no changelog stamping,
   publish guards skip it — like traffic-lab. Graduation flips the bit and does
   the first release properly.

The scaffold ticket can start without further questions.
