# @super-line/plugin-devtools

Client-side devtools tap for [super-line](https://mertdogar.github.io/super-line/). Buffers what **one tab's client** did and knows, for the super-line Chrome DevTools panel.

```bash
npm i @super-line/plugin-devtools
```

```ts
import { createSuperLineClient } from '@super-line/client'
import { devtoolsPlugin } from '@super-line/plugin-devtools'

const client = createSuperLineClient(api, {
  transport: webSocketClientTransport({ url: 'ws://localhost:3000' }),
  role: 'user',
  plugins: [devtoolsPlugin()],
})
```

Then open DevTools → **super-line**.

## What it is for

super-line already ships a server-side inspector and the Control Center, which answer *"what is the cluster doing"*. This answers a different question — *"what is this page doing"* — and the two do not overlap, because most of what a client knows never reaches the wire:

- a request created but never sent, because the socket was not writable
- how long the current reconnect will wait, and which attempt it is on
- which live subscription a delivered row landed in, and which one re-filtered it away — a different fact from a delete, and indistinguishable from one on the wire
- an inbound payload that failed contract validation on arrival
- an event delivered to **zero listeners**, which has no server-side symptom at all
- CRDT document contents, which cross the wire only as opaque deltas
- which of several concurrently-live clients a page is running

It needs no server configuration and works against a server with the inspector switched off.

## Options

```ts
devtoolsPlugin({
  maxEvents: 5000,          // ring capacity; evictions are COUNTED and shown as a gap, never silent
  redact: ['token'],        // mask these field names at every depth before buffering
})
```

Payloads are snapshotted as they arrive, so the buffer never pins an app object alive and never shows one that has since been mutated. Nothing is observed, buffered or exposed unless you add the plugin.

`redact` is about what ends up in a screenshot, not access control — the buffer lives in the page's own memory, which any script on the page can already read.

## License

MIT
