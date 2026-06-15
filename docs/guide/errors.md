# Error handling

super-line carries errors end-to-end as a typed `SocketError`. Throw one from a handler and the client's promise rejects with the **same code**.

```ts
import { SocketError } from '@super-line/core'

// server
send: async ({ room }, ctx) => {
  if (!ctx.canPost(room)) throw new SocketError('FORBIDDEN', 'not a member', { room })
  // ...
}

// client
try {
  await client.send({ room, text })
} catch (e) {
  if (e instanceof SocketError && e.code === 'UNAUTHORIZED') relogin()
}
```

A `SocketError` has a `code`, an optional human-readable `message`, and optional structured `data` (delivered to the client).

## Codes

| Code | Meaning |
| --- | --- |
| `BAD_REQUEST` | Malformed request; also used for an aborted call. |
| `UNAUTHORIZED` | Not authenticated. |
| `FORBIDDEN` | Authenticated but not allowed (e.g. a denied subscribe). |
| `NOT_FOUND` | Unknown method/topic, or one outside the connection's role surface. |
| `TIMEOUT` | The request exceeded its timeout. |
| `VALIDATION` | Inbound payload failed schema validation. |
| `DISCONNECTED` | The socket dropped (in-flight requests reject with this). |
| `INTERNAL` | An unexpected/unknown server error. |

You can also use **custom string codes** — autocomplete keeps the built-in set while allowing your own:

```ts
throw new SocketError('RATE_LIMITED', 'slow down', { retryAfter: 5 })
```

## What the client sees

- **Expected failures** — `throw new SocketError(code, ...)` from a handler; the client gets that exact `code` (and `data`).
- **Unexpected throws** — any non-`SocketError` thrown becomes `INTERNAL`, so server internals (stack traces, messages) are never leaked. Use [`onError`](./middleware-lifecycle#lifecycle-hooks) to log the real error server-side.
- **Validation** — bad inbound input rejects with `VALIDATION` before your handler runs.

## Don't return error sentinels

Return values are for success; failures are thrown. This keeps the client's `await` ergonomic (`try/catch`, not result-checking) and the types clean.

```ts
// ❌ return { error: 'nope' }
// ✅ throw new SocketError('FORBIDDEN', 'nope')
```

Next: [Reconnection & delivery](./reconnection-delivery).
