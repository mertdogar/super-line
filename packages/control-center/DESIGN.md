---
name: super-line Control Center
description: Dark instrument panel for inspecting a running super-line realtime data bus.
colors:
  signal-cyan: "oklch(0.78 0.13 200)"
  signal-ink: "oklch(0.18 0.02 240)"
  slate-abyss: "oklch(0.16 0.01 260)"
  slate-panel: "oklch(0.2 0.012 260)"
  slate-raised: "oklch(0.27 0.015 260)"
  slate-active: "oklch(0.3 0.02 260)"
  hairline: "oklch(0.3 0.015 260)"
  foreground: "oklch(0.96 0 0)"
  muted-foreground: "oklch(0.7 0.02 260)"
  alarm-red: "oklch(0.62 0.21 25)"
typography:
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.2em"
  meta:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
components:
  button-primary:
    backgroundColor: "{colors.signal-cyan}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-secondary:
    backgroundColor: "{colors.slate-raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-destructive:
    backgroundColor: "{colors.alarm-red}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  badge-default:
    backgroundColor: "oklch(0.78 0.13 200 / 0.15)"
    textColor: "{colors.signal-cyan}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  badge-muted:
    backgroundColor: "{colors.slate-raised}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.slate-panel}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "16px"
  nav-item-active:
    backgroundColor: "{colors.slate-active}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  nav-item-idle:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: super-line Control Center

## 1. Overview

**Creative North Star: "The Oscilloscope"**

Control Center is a dark instrument panel wrapped around a running realtime data bus. The screen is the calm, unlit face of a scope; the only thing that glows is the signal — the live cyan trace of traffic, presence, and connection health sweeping across the slate. Everything else is calibrated chrome that recedes so the reading stays legible. This is a debugging tool for skeptical senior engineers, not a marketing surface: it earns trust by being precise, instrument-grade, and quiet under load. The measure of success is that a developer fluent in Linear, Stripe's dashboard, or Chrome DevTools sits down and trusts every readout without pausing at a single subtly-off control.

The system is **dark-only by doctrine** (`<html class="dark">`) and built on a cool-slate tonal ramp — depth comes from lightness steps (abyss → panel → raised → active), not from shadows. One saturated accent carries the entire identity: **signal cyan** (`oklch(0.78 0.13 200)`), used for the primary action, the current selection, focus rings, and live state — never for decoration. The recurring motif, straight from the super-line brand, is **the signal made visible**: the EKG waveform mark that flatlines when the wire is closed, breathes while connecting, and sweeps while open. Realtime, rendered as a heartbeat.

It explicitly rejects SaaS-gray slop (timid neutral palettes, generic feature-card grids, hero metrics), any borrowed Stripe purple, editorial-magazine cosplay, and the whole gradient-text / glassmorphism / decorative-monospace kit. Cyan is the only voice; the tool disappears into the task.

**Key Characteristics:**
- Dark-only, cool-slate tonal layering; depth by lightness, not shadow.
- One confident accent — signal cyan — reserved for action, selection, focus, and live state.
- Instrument density: single sans, tight 14px/12px scale, data is the hero.
- The EKG waveform is the identity thread and a live status readout in one.
- Familiar devtool shell (side nav + top bar + content); no invented affordances.

## 2. Colors

A cool-slate instrument field lit by a single cyan trace, with one red reserved for alarm.

### Primary
- **Signal Cyan** (`oklch(0.78 0.13 200)`): The trace on the scope. Primary buttons, the active/selected state, focus rings (`--ring`), the live EKG sweep, and any indicator that means "live" or "connected." Its rarity is the entire point — if cyan is everywhere, nothing reads as the signal.
- **Signal Ink** (`oklch(0.18 0.02 240)`): The dark foreground that rides *on* cyan (primary button text), so the accent can stay bright without a white-on-cyan contrast miss.

### Neutral
- **Slate Abyss** (`oklch(0.16 0.01 260)`): The body background — the unlit face of the scope. The lowest layer; everything sits above it.
- **Slate Panel** (`oklch(0.2 0.012 260)`): Cards, popovers, the sidebar (at 40% over abyss). The first lift.
- **Slate Raised** (`oklch(0.27 0.015 260)`): Secondary buttons, muted badges, raised chips — the second tonal step.
- **Slate Active** (`oklch(0.3 0.02 260)`): The active nav row and hover accent surface. The top of the neutral ramp.
- **Hairline** (`oklch(0.3 0.015 260)`): Every border, divider, and input stroke. Applied globally (`* { border-color }`) so structure reads as fine ruled lines, never heavy boxes.
- **Foreground** (`oklch(0.96 0 0)`): Near-white primary text and headings.
- **Muted Foreground** (`oklch(0.7 0.02 260)`): Secondary text, meta, idle nav labels, timestamps. Still clears 4.5:1 on abyss and panel — do not push it lighter for "elegance."

### Tertiary
- **Alarm Red** (`oklch(0.62 0.21 25)`): Destructive actions and error/disconnect state only. The single non-cyan saturated color; it means something is wrong.

### Named Rules
**The One Trace Rule.** Cyan is the signal, and a scope has one trace. It carries the primary action, the current selection, focus, and live state — nothing decorative. If you're reaching for cyan to make a panel "pop," stop; the pop is reserved for the reading.

**The Lift-Not-Shadow Rule.** Elevation is a step up the slate ramp (abyss → panel → raised → active), not a drop shadow. A surface that needs to feel higher gets a lighter slate, not a darker box-shadow.

## 3. Typography

**Body / UI Font:** system sans (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`)
**Display Font:** none — this is an instrument, not a headline.
**Label/Mono Font:** the same system sans for labels; true monospace is reserved for code, IDs, and payloads inside the JSON view, never for "looking technical."

**Character:** One well-tuned system sans carries everything — nav, headings, buttons, labels, table data. The hierarchy is built from weight and size on a tight scale, not from a second face. Restraint here is the point: a devtool with two typefaces is already off.

### Hierarchy
- **Wordmark** (bold 700, 15px, tracking-tight): "super-**line**" in the sidebar lockup, the *line* in cyan. The only branded type on screen.
- **Section label** (medium 500, 10px, letter-spacing 0.2em, uppercase): "CONTROL CENTER" under the wordmark; the calibrated instrument-label voice.
- **Header / Title** (semibold 600, 14px, tracking-tight): The page title bar and card titles. Data headings.
- **Body** (regular 400, 14px, line-height 1.5): Default UI text, nav items, table cells, controls.
- **Meta** (regular 400, 12px): Counts, version, secondary detail, timestamps in muted-foreground.

### Named Rules
**The Single Face Rule.** One family, differentiated by weight (400/500/600/700) and a 12–15px working range. No display serif, no second sans, no decorative mono in the UI chrome.

## 4. Elevation

The system is **flat by default with tonal layering**. There is exactly one real shadow in the vocabulary — `shadow-sm` on cards — and its job is a whisper of separation, not lift. Depth is communicated by stepping up the cool-slate ramp: the abyss background recedes, panels sit one step lighter, raised controls one step lighter still, the active surface at the top. A hairline border finishes the separation. This is why the tool reads as an instrument face rather than a stack of floating cards.

### Shadow Vocabulary
- **Card whisper** (`box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)` — Tailwind `shadow-sm`): The only shadow. On cards, to seat them a hair above the panel. Nothing heavier ships.

### Named Rules
**The Flat Instrument Rule.** Surfaces are flat at rest and separated by tone + hairline. Reach for a lighter slate before a darker shadow. If a panel needs a glow to feel alive, that glow is cyan and it means *live*, not *elevated*.

## 5. Components

### Buttons
- **Shape:** Gently rounded (8px, `rounded-md`). 36px default height (`h-9`), `px-4 py-2`; small is 32px (`h-8`, `px-3`, 12px text); icon is a 36px square.
- **Primary:** Signal cyan background, signal-ink text. Hover drops to `primary/90`. The one loud control — used sparingly, one primary per view.
- **Secondary:** Slate-raised background, foreground text; hover `secondary/80`.
- **Outline:** Transparent on a hairline border; hover fills to slate-active with foreground text.
- **Ghost:** No chrome at rest; hover fills to slate-active. Default for dense toolbars.
- **Destructive:** Alarm-red background; hover `destructive/90`. Reserved for irreversible actions.
- **Focus:** `focus-visible:ring-2 ring-ring` (cyan). Every control shows a visible cyan focus ring — keyboard use is first-class.

### Chips / Badges
- **Style:** `rounded-md`, `px-2 py-0.5`, 12px medium. Border-transparent by default.
- **Default:** Cyan at 15% tint background, cyan text — the "live/primary" tag (node counts, active roles).
- **Muted:** Slate-raised background, muted-foreground text — neutral counts ("12 nodes", "48 conns").
- **Secondary / Outline:** Slate-raised solid, or foreground text on a hairline, for lower-emphasis tags.

### Cards / Containers
- **Corner Style:** 10px (`rounded-lg`).
- **Background:** Slate-panel on the abyss field.
- **Shadow Strategy:** `shadow-sm` only (see Elevation).
- **Border:** Hairline all around; header divided by a bottom hairline.
- **Internal Padding:** Header `px-4 py-3`; content `p-4`.

### Inputs / Fields
- **Style:** Hairline stroke on transparent/panel background, `rounded-md`.
- **Focus:** Cyan ring (`ring-ring`), matching buttons — the accent confirms focus everywhere.
- **Disabled:** `opacity-50`, pointer-events off.

### Navigation
- **Style:** Fixed 224px (`w-56`) left rail on `bg-card/40`, split into a top group (Topology, Connections, Contract, Plugins, Collections, Live feed) and a bottom group (Settings, Resources) pinned with `mt-auto`.
- **Nav item:** `rounded-md px-3 py-2`, 14px, with a 16px Lucide icon. **Active** = slate-active background, foreground text. **Idle** = muted-foreground; hover lifts to `accent/50` background and foreground text.
- **Top bar:** Page title + icon + inline count on the left; connection StatusDot and muted count badges on the right.
- **Mobile:** Not a target — this is a desktop instrument. Density over responsive fluidity.

### Brand Mark (signature component)
The **EKG waveform** (`BrandMark`) is the identity thread and a live status readout in one. A cyan pulse spike between two foreground leads: it **flatlines** (`scale-y-[0.04]`, muted) when the wire is closed, **breathes** (`cc-breathe`, 1.6s) while connecting, and a faint signal **sweeps** the full wire (`cc-sweep`, 6s) while open. CSS-only, `prefers-reduced-motion` aware. It is the literal embodiment of "the signal is the brand" — never redraw it as a generic logo, and never let another element borrow the cyan sweep.

## 6. Do's and Don'ts

### Do:
- **Do** keep cyan rare — primary action, current selection, focus ring, and live state only. Its scarcity is what makes it read as the signal.
- **Do** build depth by stepping up the slate ramp (abyss → panel → raised → active) plus a hairline, not by adding shadows.
- **Do** use one system sans across the whole UI, differentiated by weight and a tight 12–15px scale.
- **Do** give every interactive control its full state set — default, hover, focus (cyan ring), active, disabled — and a cyan `focus-visible` ring for keyboard users.
- **Do** let data be the hero: dense tables, compact badges, muted meta. The tool disappears into the task.
- **Do** treat the EKG mark as both brand and status; keep its `prefers-reduced-motion` fallback.

### Don't:
- **Don't** spend cyan on decoration, gradients, or "making a panel pop." One trace.
- **Don't** ship **SaaS-gray slop** — timid neutral palettes, generic icon-card grids, or a hero-metric block. Safe reads as invisible here.
- **Don't** borrow **Stripe's purple** or any second accent hue; cyan is the only voice, red is only for alarm.
- **Don't** use **gradient text** (`background-clip: text`), **glassmorphism**, or **decorative monospace** in UI chrome — mono is for code and IDs, not for looking technical.
- **Don't** put **display fonts** in labels, buttons, or data, and don't add a second typeface.
- **Don't** use a `border-left`/`border-right` colored side-stripe on cards, rows, or callouts; use full hairline borders or a tinted background.
- **Don't** reach for a **modal** as the first thought — prefer the existing inline detail panels (ConnDetail slides in; it doesn't trap).
- **Don't** reinvent standard devtool affordances (custom scrollbars, novelty form controls, invented nav) for flavor. Earned familiarity is the bar.
- **Don't** introduce a light theme; this instrument is dark by doctrine.
