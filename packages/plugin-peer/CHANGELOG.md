# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [plugin-peer-v0.1.0] — 2026-11-25

### Features

- **plugin-peer:** Rooms survive reconnects with automatic re-join ([1ce9d0f])
- **plugin-peer:** Client half with full-mesh rooms over WebRTC data channels ([d8b5f68])
- **plugin-peer:** Contract and stateless server half for client-to-client rooms ([bf2d8a5])

### Bug Fixes

- **plugin-peer:** A refused re-claim closes the room ([4615a75])
- **plugin-peer:** Keep the room key out of the default error log ([9b7457f])
- **plugin-peer:** Only the impolite side makes a link's first offer ([e98d07f])
- **plugin-peer:** Links connect and close cleanly on a real WebRTC stack ([e866ef5])

### Documentation

- **plugin-peer:** Guide, ADR-0030 and the agent skill for client-to-client rooms ([d4facb2])


