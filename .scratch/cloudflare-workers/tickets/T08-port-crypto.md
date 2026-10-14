---
id: T08
title: Port node:crypto users to WebCrypto where nodejs_compat falls short
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T02,T05]
---

## Question

> T02 result: `nodejs_compat` covers everything imported, so this is expected to close as verification-only (one in-workerd test of scrypt + Buffer interop, plus the `nodejs_compat` flag requirement documented).

Per T02: for each of `plugin-auth` (scrypt, randomBytes, timingSafeEqual, jose), `plugin-inspector` (createHash, timingSafeEqual), `plugin-chat` (randomUUID), either confirm it runs under `nodejs_compat` with a workers-lane test, or port to WebCrypto / `globalThis.crypto` keeping the stored hash format (`scrypt$N$r$p$salt$hash`) byte-compatible so existing user rows still verify. If T02 shows full coverage this ticket closes as a verification-only task.
