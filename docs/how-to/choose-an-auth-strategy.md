# Choose an auth strategy

Decide how a connection proves who it is. Both strategies run at connect time through the same [`authenticate(handshake)`](/how-to/roles-auth) seam — the difference is how much identity machinery you own versus hand to a plugin.

::: tip The primitive vs. the system
`authenticate` is the **connect-time primitive**: you verify a credential yourself and return `{ role, ctx }`. [`@super-line/plugin-auth`](/how-to/plugin-auth) is the **batteries-included identity system** built on that same seam — email/password, sessions, data-driven roles, API keys, and JWT, with every identity held in typed [collections](/collections/). They aren't exclusive: the plugin _is_ an `authenticate` implementation, so reaching for it doesn't lock anything else out.
:::

## Pick a strategy

| If you… | Use | Where |
|---|---|---|
| Already have an identity store (your own JWT, session, or DB) and just need to verify a credential and freeze a role at connect | **Hand-rolled `authenticate`** | [Authenticate & assign roles](/how-to/roles-auth) |
| Want email/password, durable sessions, roles-as-data, API keys, and JWT out of the box — identity in typed collections, wired in three lines | **`@super-line/plugin-auth`** | [Add authentication (plugin)](/how-to/plugin-auth) |

Reach for the plugin unless you're bringing your own identity system — it's the fastest path to a real login, and every page below builds on it.

## The plugin, in three touch-points

Adding the plugin is the same three edits every time — the contract, the server, the client:

```ts
plugins: [authContract()]                          // 1 · contract — adds guest + the auth collections & requests
authenticate: authKit.authenticate                 // 2 · server — plus identify + plugins:[authKit.plugin]
export const { AuthProvider, useAuth } = createAuth({ authedRole: 'user', connect }) // 3 · client
```

The [plugin overview](/how-to/plugin-auth) shows the full wiring; the pages after it go deep on each capability.

Next: [Add authentication (plugin)](/how-to/plugin-auth) · [Sessions, roles & API keys](/how-to/auth-sessions-roles-keys) · [JWT & sealed tokens](/how-to/auth-jwt-sealed-tokens) · [Server-side hooks](/how-to/auth-hooks) · [Provision an agent identity](/how-to/auth-agent-identity) · [Reset a password](/how-to/auth-password-reset). For the model — the connection lifecycle and why sealed tokens are server-minted — see [the auth lifecycle](/concepts/auth-lifecycle-sealed-tokens).
