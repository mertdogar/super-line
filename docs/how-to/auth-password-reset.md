# Reset a password

Logged-out account recovery for `@super-line/plugin-auth`. super-line never sends email itself — it hands
you the reset token through a host callback and lets you deliver it however you like (email, SMS). The two
requests live on the **guest** role, so a signed-out user can drive the whole flow.

## Wire the delivery callback

`sendPasswordReset` on `auth(...)` receives the target user and a freshly-minted token. Send the user a link
that carries the token (e.g. `?token=…`) so your reset page can pass it back:

```ts
import { auth } from '@super-line/plugin-auth/server'

const authKit = auth({
  contract: app,
  collections: backend,
  sendPasswordReset: async ({ user, token }) => {
    await mailer.send(user.displayName, `https://app.example.com/reset?token=${token}`)
  },
})
```

- The token's lifetime is `passwordResetTtlMs` (default **1 hour**).
- Without the callback, `requestPasswordReset` is a **silent no-op** — no token is minted, no error is thrown.

## The reset flow

A guest client asks for a reset by email, then confirms with the token it received and a new password:

```ts
import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'

const guest = createSuperLineClient(app, { role: 'guest', transport: webSocketClientTransport({ url }) })

// 1 · request — always resolves the same way
await guest.requestPasswordReset({ email: 'ada@example.com' }) // → { ok: true }

// 2 · confirm — with the token from the delivered link + the new password
await guest.confirmPasswordReset({ token, newPassword: 's3cret-pa55phrase' }) // → { ok: true }
```

- **`requestPasswordReset({ email })` always returns `{ ok: true }`** and never reveals whether the email
  exists. The `sendPasswordReset` callback fires only if that email has a credential — an unknown address
  resolves identically, so the response leaks nothing.
- **`confirmPasswordReset({ token, newPassword })` rejects** an expired or unknown token, or a token whose
  owner has been deactivated. On success it rotates the password hash and **revokes every access token and
  ends every session** — a reset logs the user out of all devices, so the attacker who prompted the reset is
  cut off too.

::: tip A reset is a full logout
Because confirm flushes the user's access tokens and sessions cluster-wide, the account's other live
connections drop on the next write. Have the user sign in again with the new password.
:::

Next: [The auth lifecycle](/concepts/auth-lifecycle-sealed-tokens) · back to [Choose an auth strategy](/how-to/choose-an-auth-strategy).
