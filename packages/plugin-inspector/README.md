# @super-line/plugin-inspector

The [Control Center](https://super-line.dogar.biz/how-to/control-center) inspector for [**super-line**](https://super-line.dogar.biz/), packaged as a [plugin](https://super-line.dogar.biz/concepts/plugins) — taps every request/event, redacts + snapshots payloads, and serves a plugin-owned connection class the Control Center attaches to. **Dev / trusted-network only** — read-only, off by default, and **unlocked unless you set a credential**.

```bash
pnpm add @super-line/core @super-line/server @super-line/plugin-inspector
```

```ts
import { createSuperLineServer } from '@super-line/server'
import { webSocketServerTransport } from '@super-line/transport-websocket'
import { inspector } from '@super-line/plugin-inspector'

const srv = createSuperLineServer(contract, {
  transports: [webSocketServerTransport({ server })],
  authenticate,
  plugins: [inspector()],
})
```

Then point the Control Center at the node — no install, no extra instrumentation:

```bash
npx @super-line/control-center --url ws://localhost:3000
```

`inspector({ redact: [...] })` masks named `ctx`/`data` fields; `revealEnvKeys` opts specific `env` keys into the clear (env is masked by default). Inspector connections bypass the host's `authenticate` and stay out of presence/heartbeat/`local`/`cluster` results, so the observer never shows up in what it observes.

Because they bypass `authenticate`, the plugin authorizes them itself. Unconfigured, it admits anyone who can reach the port — and reads every collection with row policies bypassed — so it warns at boot. Set `SUPER_LINE_INSPECTOR_PASSWORD` (username defaults to `admin`, override with `SUPER_LINE_INSPECTOR_USER`), or pass `inspector({ auth: { username, password } })`, or hand `auth` a predicate over the handshake that throws to refuse. A refusal reaches the Control Center as a distinct `unauthorized` state, which stops it retrying.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [inspect a cluster with Control Center](https://super-line.dogar.biz/how-to/control-center)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
