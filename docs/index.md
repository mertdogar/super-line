---
layout: home
hero:
  name: super-line
  text: Typesafe WebSockets for TypeScript
  tagline: One contract, split by direction and scoped by role. Requests, events, topics, rooms & a cluster event bus — with end-to-end types and zero codegen.
  image:
    src: /mark.svg
    alt: super-line
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: The contract
      link: /guide/the-contract
    - theme: alt
      text: API reference
      link: /reference/
features:
  - title: 🧩 Contract-first
    details: One schema is the single source of truth; types flow to both ends with zero codegen.
  - title: 🎭 Role-scoped
    details: One contract, many client roles (user, agent…) — each gets its own surface and ctx; cross-role calls get NOT_FOUND.
  - title: 🛡️ Runtime-validated
    details: Any Standard Schema validator (Zod, Valibot, ArkType). The server validates every inbound message.
  - title: ↔️ Req/res with typed errors
    details: Unary await client.x() with timeouts, AbortSignal, and a typed SocketError model.
  - title: 📡 Events, rooms & topics
    details: Server-pushed events, server-controlled room broadcasts, and client-subscribed pub/sub streams.
  - title: 📈 Scales across nodes
    details: Rooms, topics, and a cluster event bus fan out across processes via a pluggable adapter (Redis included).
---
