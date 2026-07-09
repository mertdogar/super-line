---
lastUpdated: false
---

# Error codes

The wire error type is `SuperLineError` from `@super-line/core`. Throw one from a handler and the client's promise rejects with the same `code` (and optional `data`). For usage — throwing, catching, custom codes — see [Handle errors](/how-to/errors).

```ts
import { SuperLineError } from '@super-line/core'
throw new SuperLineError('FORBIDDEN', 'not a member', { room })
//                        code         message         optional data
```

## Built-in codes

`SuperLineErrorCode` is the built-in set; `code` also accepts any custom string.

| Code | Meaning | Typical source |
| --- | --- | --- |
| `BAD_REQUEST` | malformed / unprocessable request | a bad or aborted call |
| `UNAUTHORIZED` | not authenticated | `authenticate` rejected the handshake |
| `FORBIDDEN` | authenticated but not allowed | a denied [subscribe](/how-to/topics) or a policy/guard |
| `NOT_FOUND` | no such request/topic for this role | a [cross-role call](/how-to/roles-auth), an unopened doc |
| `TIMEOUT` | no reply within the deadline | a request that exceeded `timeoutMs` |
| `VALIDATION` | payload failed its schema | inbound [input/payload](/reference/cheatsheets/contract-shapes) rejected |
| `DISCONNECTED` | the connection dropped | socket lost before the reply |
| `INTERNAL` | unexpected server error | an unknown throw in a handler (details not leaked) |

An unknown throw from a handler becomes `INTERNAL` so server internals aren't exposed. Custom codes are just strings — `throw new SuperLineError('RATE_LIMITED', …)` — and reach the client verbatim.

See the [API reference](/reference/@super-line/core/classes/SuperLineError) for the class surface.
