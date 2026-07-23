# @super-line/plugin-inspector

The [Control Center](https://super-line.dogar.biz/how-to/control-center) inspector for [**super-line**](https://super-line.dogar.biz/), packaged as a [plugin](https://super-line.dogar.biz/concepts/plugins) — taps every request/event, redacts + snapshots payloads, and serves a plugin-owned connection class the Control Center attaches to. **Dev / trusted-network only** — it's unauthenticated and read-only, off by default.

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

`inspector({ redact: [...] })` masks named `ctx`/`data` fields; `revealEnvKeys` opts specific `env` keys into the clear (env is masked by default). Inspector connections bypass `authenticate` and stay out of presence/heartbeat/`local`/`cluster` results, so the observer never shows up in what it observes.

- 📖 Docs: <https://super-line.dogar.biz/>
- 📚 Guide: [inspect a cluster with Control Center](https://super-line.dogar.biz/how-to/control-center)
- 🧩 Source: <https://github.com/mertdogar/super-line>

MIT © Mert
