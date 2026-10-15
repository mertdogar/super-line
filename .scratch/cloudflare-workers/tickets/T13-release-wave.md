---
id: T13
title: Release wave
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T12]
---

## Question

Stage the release: versions for every touched package (core/server for the seam and timer option; the plugins ported; the three new packages at 0.1.0), peer ranges, `chore(release)` + tags + root aggregate after tagging, `check-manifest` + `check-changelog` settle, full suite green across all three lanes. Publish/push is the user's call — ASK.

> From T07: raise `@super-line/transport-cloudflare`'s core peer floor from `>=0.20.0` to the core minor that ships `adoptConnection`/`onSnapshotChanged` (and do the same for any other package that starts depending on them).
