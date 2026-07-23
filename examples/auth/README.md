# example: auth

Proper authentication with [`@super-line/plugin-auth`](../../packages/plugin-auth) — email/password
sign-up + login, server-issued sessions, and **data-driven roles**, with all identity held in typed
**collections**.

```bash
pnpm --filter @super-line/example-auth start
```

## What it shows

- **`authContract()`** merged into the contract adds the `guest` role, the `users`/`credentials`/`sessions`
  collections, and `signIn`/`signUp`/`signOut`/`whoami` — so the app declares only its own surface.
- **`auth()`** (server) provides `authenticate` + `identify` + the plugin (handlers + row policies + scrypt
  password hashing). Wired in a few lines; `implement()` only needs the app's own requests.
- **`authClient()`** hides super-line's guest→user reconnect: `signUp()` connects as guest, mints a session,
  and transparently rebuilds the client as `user`.
- **Row security via the logged-in user:** a private `notes` collection keyed on `principal` (= userId) — Alice
  and Bob each see only their own; the `users` directory is public.
- **Roles are just data:** granting Alice `admin` (a co-write to her user row) lets her existing access token
  open an `admin` connection.
- **JWT — a signed assertion, not a stored credential.** `getToken()` mints a short-lived HS256 token from a
  live session. Another backend verifies it with the secret **alone** — no super-line, no database — and a
  client can connect with `params: { jwt }` and still get a real connection session (`authMethod: 'jwt'`).
  Then the cost, stated honestly: `revoke()` ends Bob's sessions and disconnects him everywhere, but his
  outstanding JWT is in no table to revoke and **keeps working until it expires**. `deactivate()` stops even
  that — the one user read at connect is the emergency stop.
- **Sign-out revokes** the session and drops the client back to `guest`.

The Slack-style [`collections-chat`](../collections-chat) example is the larger, UI-driven counterpart.
