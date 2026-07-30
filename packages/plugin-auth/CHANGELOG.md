# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [plugin-auth-v0.10.0] — 2026-07-30

### Features

- **react,plugin-auth:** StrictMode is supported — useSuperLineClient + committed-effect auth provider ([d56c759])
- **plugin-auth:** React half feeds the shared binding — Register and re-exports removed ([d598faa])
- **react:** Hook upgrades — useLiveQuery, lazy useDoc ids, readiness/error/handles, unified useRequest ([d618e52])

### Testing

- One polling wait with backoff, and teardown that cannot hang ([e86664a])

### Documentation

- The teaching surface teaches one registered React binding ([45187f4])

## [plugin-auth-v0.9.1] — 2026-07-29

### Bug Fixes

- **plugin-auth:** Write presence once per session change, not twice ([37ff0bb])

### Documentation

- Index the design plans and record the citation rule ([7648ee5])
- Stop citing internal design docs from published material ([4f7f7d7])

## [plugin-auth-v0.9.0] — 2026-07-27

### Bug Fixes

- **core:** Derive column layout from Standard JSON Schema, not bundled zod classes ([02d182f])

### Refactor

- Use zod 4's namespace import form everywhere ([faebe1c])

## [plugin-auth-v0.8.0] — 2026-07-25

### Features

- **plugin-auth,react:** Auth owns the client — reauthenticate() + one merged React binding ([de2b59d])

### Documentation

- Record ADR-0020 and rewrite the auth guides onto the merged binding ([29e14ee])

## [plugin-auth-v0.7.0] — 2026-07-24

### Features

- **plugin-auth:** ResolveToken + AuthState.error ([3f8a129])
- **plugin-auth:** TokenParam + rejectUnauthenticated ([28b9798])
- **plugin-auth:** Retire client-side token minting ([ae2f7d2])
- **logging:** Surface swallowed auth throws + clarify the nodeKey requirement ([0120e54])
- **logging:** Adopt LogTape for structured internal diagnostics (ADR-0018) ([6e4b841])
- **plugin-auth:** Server-side hooks around authenticate + the imperative kit ([4763c80])

## [plugin-auth-v0.6.1] — 2026-07-23

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

## [plugin-auth-v0.6.0] — 2026-07-23

### Features

- **auth:** Split bearer assertions into signed and sealed ([785a839])
- **example:** Demonstrate JWT auth and getToken ([73ba14b])

## [plugin-auth-v0.5.0] — 2026-07-22

### Features

- **auth:** Add connection sessions and member presence ([1dcad5f])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

## [plugin-auth-v0.4.0] — 2026-07-18

### Bug Fixes

- **deps:** Core (and client) become peerDependencies in plugin-inspector, plugin-auth, tanstack-db ([f2a5cd5])

## [plugin-auth-v0.3.0] — 2026-07-17

### Features

- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])
- **plugin-auth:** Imperative users/apiKeys management + soft-delete (plugin-chat Phase 0) ([373130c])

### Chores

- Add LICENSE files to plugin-auth + plugin-chat for publish ([150a9ce])

### Documentation

- Typed-table factory signatures across docs, skills, READMEs, CLAUDE.md ([5df22b4])
- **plugins:** Document full authKit + chatKit method surfaces ([201a4be])
- **plugins:** Add plugin-auth README, expand plugin-chat README ([b48371a])

## [plugin-auth-v0.1.1] — 2026-07-16

### Features

- **plugin-auth:** React binding (/react) + displayName in the identity ([2f93561])
- **plugin-auth:** API keys, JWT, revoke-and-kick, password reset ([422ca01])
- **plugin-auth:** First-party authentication as a paired plugin ([2fe2df2])


