---
id: T11
title: Build examples/cloudflare and deploy it
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T07,T09,T10]
---

## Question

A real `examples/cloudflare`: Worker + DO class hosting a super-line server with auth + chat (or collections) + inspector, wrangler config with `nodejs_compat` and `new_sqlite_classes`, a browser client that connects over the new transport, a README that walks `wrangler dev` and `wrangler deploy`. Prove it deployed to a real account at least once (hibernation observed via the dashboard or logs); record the URL shape and gotchas in the resolution. Ask the user before any deploy that costs money.

> From T10: local workerd enforces NO 2 MB row limit, so the rows backend's over-2-MB error (it relies on the platform's) is only observable on the real deploy — confirm it there and record the message. CRDT docs refuse >2 MB themselves. A CRDT edit is written through 250 ms later; a deploy inside that window loses it — worth one line in the example README.
