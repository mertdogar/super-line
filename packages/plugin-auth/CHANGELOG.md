# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

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


