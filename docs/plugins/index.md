# Plugins

Plugins add a focused capability to a super-line application. This catalog
lists packages curated by the super-line project, including packages shipped in
this repository and independently maintained ecosystem integrations.

Each entry identifies its maintainer status and links to the package's setup
guide. To propose a listing, open a pull request against the
[super-line documentation repository](https://github.com/mertdogar/super-line).

## Available plugins

Choose a plugin by the capability you need. The first two entries are
first-party packages published from the super-line monorepo; Super Harness is
an ecosystem plugin maintained in its own repository.

### Authentication

**First-party · Authentication**

[`@super-line/plugin-auth`](/how-to/plugin-auth) adds email/password sign-up,
sessions, API keys, JWTs, and data-driven roles. Its contract fragment,
server plugin, and client helpers keep authentication on the same
server-authoritative connection as your application.

### Control Center inspector

**First-party · Observability**

[`@super-line/plugin-inspector`](/how-to/control-center) exposes the Control
Center's live topology and traffic view through a plugin-owned connection. Add
it when you need to inspect a running cluster without custom instrumentation.

### Super Harness

**Ecosystem plugin · AI agent runtime**

[Super Harness](/plugins/super-harness) adds a persistent, streaming
supervisor and subagent runtime to an existing super-line server. It uses
typed collections for the durable session tree and preserves full-fidelity
streaming at every depth.

## Next steps

Read [the plugin model](/concepts/plugins) to understand the contract-time and
runtime halves of a plugin, or follow [Build a plugin](/how-to/building-plugins)
to publish your own.
