# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [plugin-chat-v0.8.0] — 2026-07-23

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

## [plugin-chat-v0.7.0] — 2026-07-22

### Features

- **auth:** Add connection sessions and member presence ([1dcad5f])

## [plugin-chat-v0.6.3] — 2026-07-21

### Features

- **plugin-chat:** Publish the resource access resolvers on chatKit ([466812e])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

## [plugin-chat-v0.6.2] — 2026-07-20

### Bug Fixes

- **plugin-chat,control-center:** Reset history during render + keyboard-reachable rows ([4a02fae])

## [plugin-chat-v0.6.1] — 2026-07-19

### Features

- **examples,plugin-chat:** Showcase 0.6.0 features in chat examples ([d8fe270])
- **plugin-chat:** 0.6.0 — the OMMA-findings train ([57238b6])

## [plugin-chat-v0.5.0] — 2026-07-19

### Features

- **plugin-chat:** Adopt durable generic stream architecture ([dce8ec1])

## [plugin-chat-v0.4.0] — 2026-07-18

### Refactor

- **plugin-chat:** MastraEngine is thin glue — drop maxSteps mirrors, memory via Agent defaultOptions ([33827ca])

### Documentation

- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [plugin-chat-v0.3.0] — 2026-07-17

### Features

- **plugin-chat:** Channel resources — kind registry, owned/linked lifecycle, acked writes, /ai tools, presence ([0f979e4])

### Documentation

- **chat-resources:** PLAN + how-to guide + runnable example + README/skill tail ([c81b57e])

## [plugin-chat-v0.2.0] — 2026-07-17

### Features

- **plugin-chat:** OnChatMessage bot loop + provisionChatBot (PLAN-chat-mastra Phase B) ([3e82f04])
- **plugin-chat:** /mastra subpath — mastraEngine wires plain Mastra Agents to streamed messages ([05373d3])
- **plugin-chat:** Streaming Phase 3 — pipeUIMessageStream + a live streaming agent ([f90400a])
- **plugin-chat:** Streaming Phase 2 — client writer + one assembled feed ([8bf554f])
- **plugin-chat:** Streaming messages Phase 1 — parts-as-rows server core ([7191ce8])
- **plugin-chat:** AI SDK agent toolset — /ai subpath (PLAN decision 17) ([89ca8f6])
- **plugin-chat:** Client/react halves + collections-chat rewrite with a live LLM agent (Phase 2) ([39beca1])
- **plugin-chat:** Chat backbone plugin — Phase 1 core (contract fragment + hookable server kit) ([52836b9])

### Bug Fixes

- **plugin-chat:** Review fixes — bot-name hijack, self-delegation, chain teardown ([611925d])

### Refactor

- **examples:** Both bots onto the plugin-chat helpers; docs for /mastra + the bot loop ([3b8e3cf])

### Chores

- Add LICENSE files to plugin-auth + plugin-chat for publish ([150a9ce])

### Documentation

- **plugins:** Document full authKit + chatKit method surfaces ([201a4be])
- **plugins:** Add plugin-auth README, expand plugin-chat README ([b48371a])
- **plugin-chat:** Document the /ai agent toolset ([baacde5])
- **plugin-chat:** Tutorial 4, close doc gaps, fix imperative-kit snippet ([f23ac20])


