# Product

## Register

brand

## Users

TypeScript developers evaluating or adopting a realtime layer for their app — the kind who reach for tRPC, Zod, and end-to-end type safety by reflex. They arrive from GitHub, a tweet, or a "typesafe websockets" search, usually while comparing options (Socket.IO, plain `ws`, tRPC subscriptions). Their context is a code editor in the other window: they want to judge in under a minute whether the contract model and the inference are real, then get to a working server + client fast. The audience is technical and skeptical — claims don't land, working code does.

The job to be done: **decide that super-line is worth adopting, then get productive.** The home page must earn the click to "Get started"; the guides must get them to a typed round-trip without friction; the API reference must be trustworthy enough to live in day-to-day.

## Product Purpose

super-line is an end-to-end typesafe WebSocket library for TypeScript. You write one contract — split by direction (`clientToServer` / `serverToClient`) and scoped by role (`user`, `agent`, `shared`) — and the server implements it while the client calls it with full inference and zero codegen. Requests, server-pushed events, rooms, client-subscribed topics, and a cluster-wide event bus all share one connection and fan out across processes via a pluggable adapter (in-memory or Redis). It ships with presence/introspection and a Control Center debug webapp.

This docs site is the front door: a home-page hero that makes the contract-first, role-scoped pitch land instantly; a guide track that walks from first round-trip to scaling and AI agents; and a generated API reference. Success = a visiting developer understands the contract model from the hero, reaches a working example without getting lost, and trusts the project enough to `pnpm add` it.

## Brand Personality

Fast & modern, precise & engineered, and bold & opinionated. The voice is a confident senior engineer who has strong, defensible opinions and proves them with code rather than adjectives. Tone is direct and exact — every term means something (contract, role, direction, topic, room, bus). The waveform mark is the spine of the identity: a clean signal on a line, realtime data made visible. The surface should feel premium and considered (Stripe-grade craft and information architecture) while staying unmistakably a developer tool — code is always the hero, never decoration around it.

## Anti-references

- **Stock VitePress default** — the indigo-on-white, every-OSS-site-looks-the-same baseline. We start from VitePress but the theme must carry super-line's own cyan identity, not the framework's.
- **SaaS-gray slop** — timid neutral palette, generic feature-card grid, a hero metric and three rounded-icon cards. Safe reads as invisible here.
- **Borrowing Stripe's palette.** Stripe is the reference for *polish, generosity, and IA* — not for purple-on-white. The accent stays cyan; the lesson is craft, not color.
- **Editorial-magazine cosplay** — display-serif + italic drop caps + ruled broadsheet columns. This is a dev tool, not a literary journal.
- **Gradient-text headlines, glassmorphism, and decorative monospace.** Mono is for code, not for "looking technical."

## Design Principles

1. **The signal is the brand.** The waveform/EKG line is the recurring motif — a clean cyan signal on a steady line. Realtime, made visible. Use it as the identity thread, not as scattered decoration.
2. **Show the types working.** Code samples and live inference are the hero of the home page and every guide. Demonstrate the round-trip; never claim type safety in prose where a snippet would prove it.
3. **Premium, never ceremonial.** Match Stripe's craft and information architecture — generous spacing, clear hierarchy, trustworthy reference layout — but a developer should never wait on chrome or animation to reach the code.
4. **One confident accent.** Cyan carries the whole identity. Don't hedge into neutral gray for "professionalism"; commit to the color and let it do the work.
5. **Bold but legible.** Opinionated and distinct, yet body copy and code always meet AA contrast in both themes. Strangeness lives in composition and the brand motif, never at the cost of readability.

## Accessibility & Inclusion

- **WCAG 2.1 AA** across both themes: body text ≥ 4.5:1, large text ≥ 3:1, against its actual background (including tinted code surfaces).
- **Ship both light and dark themes** to a polished bar — dark is where the cyan mark sings, but light must be equally legible, not an afterthought.
- **Cyan is never the only signal.** Pair color with text, weight, or icon for any state (active nav, callout type, link emphasis) so color-vision-deficient and grayscale readers don't lose meaning.
- **Respect `prefers-reduced-motion`** — every entrance/reveal has a crossfade or instant fallback.
- Keyboard-navigable nav, search, and code-copy controls with visible focus states.
