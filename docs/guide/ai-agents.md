# Use with your AI agent

super-line ships an **agent guide** — the contract model, the interaction flavors, auth, scaling, testing, and the common pitfalls — so your AI coding agent writes correct super-line code instead of guessing. Install it into your project and your agent picks it up.

It comes in two forms:

- **Claude Code** gets the full skill — `SKILL.md` (always-loaded trigger) plus `REFERENCE.md` / `RECIPES.md` loaded on demand (progressive disclosure).
- **Every other agent** gets a single condensed `AGENTS.md` that points to this site for depth.

All of it lives in the public repo under [`skills/super-line/`](https://github.com/mertdogar/super-line/tree/main/skills/super-line), so installing is a `degit` (or copy) away — no extra tooling.

## Claude Code

Copy the skill into your project (or `~/.claude/skills/` to make it global):

```bash
npx degit mertdogar/super-line/skills/super-line .claude/skills/super-line
```

It activates automatically when you import from `@super-line/*` or mention super-line — no config needed.

## Cursor

Fetch the condensed guide as a Cursor rule, then add Cursor's frontmatter:

```bash
npx degit mertdogar/super-line/skills/super-line/AGENTS.md .cursor/rules/super-line.mdc
```

Prepend this to the top of `.cursor/rules/super-line.mdc`:

```md
---
description: super-line — typesafe WebSocket contracts (roles + direction)
alwaysApply: true
---
```

## GitHub Copilot

```bash
npx degit mertdogar/super-line/skills/super-line/AGENTS.md .github/instructions/super-line.instructions.md
```

Prepend Copilot's frontmatter:

```md
---
applyTo: "**"
---
```

## Any other agent (Windsurf, Cline, Codex, Zed, …)

Most newer agents read an `AGENTS.md` at the project root, or can be pointed at any markdown file. Drop the condensed guide in as-is — no frontmatter needed:

```bash
npx degit mertdogar/super-line/skills/super-line/AGENTS.md AGENTS.md
```

If your agent uses a different rules path (e.g. `.windsurfrules`, `.clinerules/`), put the same file there instead.

## Keeping it current

The guide tracks the published API. Re-run the `degit` command to refresh after upgrading super-line. The content mirrors these docs, so an agent that can browse the web can also just be pointed at <https://mertdogar.github.io/super-line/>.

> Prefer plain copy over `degit`? Every file is browsable at [`skills/super-line/`](https://github.com/mertdogar/super-line/tree/main/skills/super-line) — copy its contents into the path your agent expects.
