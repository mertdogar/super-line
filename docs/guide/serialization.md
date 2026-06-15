# Serialization

Every frame is encoded by a `Serializer`. The default is JSON; you can swap in something richer. The server and client **must use the same serializer**.

## The default: JSON

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

## Richer types: superjson

To preserve `Date`, `Map`, `Set`, `BigInt`, etc. transparently, plug in a `superjson`-backed serializer on **both** ends:

```ts
import superjson from 'superjson'
import type { Serializer } from '@super-line/core'

const serializer: Serializer = {
  encode: (v) => superjson.stringify(v),
  decode: (d) => superjson.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
}

createSocketServer(api, { server, authenticate, serializer })
createClient(api, { url, role: 'user', serializer })   // MUST match
```

## Custom serializers

A `Serializer` is just:

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

Next: [Scaling & adapters](./scaling-adapters).
