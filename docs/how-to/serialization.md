# Configure serialization

Every frame is encoded by a `Serializer`. The default is JSON; swap in something richer when your payloads carry types JSON can't represent. The server and client **must use the same serializer** — a mismatch produces garbled decodes, not a clean error.

## Handle dates under the default JSON codec

`jsonSerializer` (the default) is fast and universal, but JSON has no notion of `Date`, `Map`, `Set`, `BigInt`, etc. A `Date` you send becomes a **string** on the other end:

```ts
serverToClient: { tick: { payload: z.object({ at: z.date() }) } }
// ❌ z.date() will fail to validate the string JSON produced
```

Two ways to handle dates with JSON:

```ts
// 1. coerce on the receiving schema
{ at: z.coerce.date() }       // accepts the ISO string and parses it back to a Date

// 2. send a number and convert yourself
{ at: z.number() }            // Date.now() on the way out, new Date(at) on the way in
```

## Preserve rich types with superjson

To preserve `Date`, `Map`, `Set`, `BigInt`, etc. transparently, plug in a `superjson`-backed serializer on **both** ends:

```ts
import superjson from 'superjson'
import type { Serializer } from '@super-line/core'
import { webSocketServerTransport, webSocketClientTransport } from '@super-line/transport-websocket'

const serializer: Serializer = {
  encode: (v) => superjson.stringify(v),
  decode: (d) => superjson.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
}

createSuperLineServer(api, { transports: [webSocketServerTransport({ server })], authenticate, serializer })
createSuperLineClient(api, { transport: webSocketClientTransport({ url }), role: 'user', serializer })   // MUST match
```

## Write a custom serializer

A `Serializer` is just two functions:

```ts
interface Serializer {
  encode(value: unknown): string | Uint8Array
  decode(data: string | Uint8Array): unknown
}
```

Returning a `Uint8Array` lets you use a binary format (e.g. msgpack). As always, both ends must agree.

::: warning Validation still runs
Validation happens **after** decode, against your schemas. So even with `superjson`, your schema must describe the decoded shape (a real `Date`, for `superjson`; a string/number, for JSON).
:::

Next: [Choose an adapter](/how-to/choose-an-adapter).
