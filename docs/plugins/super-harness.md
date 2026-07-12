# Super Harness

[Super Harness](https://github.com/mertdogar/super-harness) is an ecosystem
plugin for building and operating multi-agent applications. It adds a
supervisor/subagent runtime with durable session trees, human-in-the-loop
approvals, and full-fidelity streaming over your existing super-line
connection.

## What it adds

Super Harness contributes the harness request and event surface plus four
typed collections: `harness.threads`, `harness.nodes`, `harness.tools`, and
`harness.membership`. It works alongside your own contract, handlers,
authentication, and collections backend; it doesn't require a second service
or client connection.

## Add it to your server

Merge the contract fragment, mount the server plugin, and provide the same
collections backend and authenticated principal that your application uses.

```ts
import { defineContract, defineSurface } from '@super-line/core'
import { createSuperLineServer } from '@super-line/server'
import { memoryCollections } from '@super-line/collections-memory'
import { createHarness } from '@super-harness/core'
import { harness } from '@super-harness/server'
import { harnessContract } from '@super-harness/shared'

const app = defineContract({
  plugins: [harnessContract()],
  shared: defineSurface({}),
  roles: { user: {} },
})

const engine = createHarness({ supervisor, subagents: [{ agent: researcher }] })

const server = createSuperLineServer(app, {
  transports,
  collections: memoryCollections(),
  authenticate,
  identify: (connection) => connection.ctx.userId,
  plugins: [harness(engine)],
})
```

`identify` is required for the harness's membership-based row-level security.
Without it, clients can connect but can't read their session tree. The harness
owns its `harness.*` handlers, so they are removed from your `implement()`
obligation.

## Learn more

For package installation, prerequisites, standalone hosting, React bindings,
and complete examples, read the [Super Harness documentation](https://mertdogar.github.io/super-harness/)
or browse the [Super Harness repository](https://github.com/mertdogar/super-harness).

To understand how this integration composes with the host application, read
[the plugin model](/concepts/plugins) and [Build a plugin](/how-to/building-plugins).
