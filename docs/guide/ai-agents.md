# Use with your AI agent

super-line ships an **agent guide** — the contract model, the interaction flavors, auth, scaling, testing, and the common pitfalls — so your AI coding agent writes correct super-line code instead of guessing. Install it into your project and your agent picks it up.

It comes in two forms:

- **Claude Code** gets the full skill — `SKILL.md` (always-loaded trigger) plus `REFERENCE.md` / `RECIPES.md` loaded on demand (progressive disclosure).
- **Every other agent** gets a single condensed `AGENTS.md` that points to this site for depth.

All of it lives in the public repo under [`skills/super-line/`](https://github.com/mertdogar/super-line/tree/main/skills/super-line) — no extra tooling. Claude's skill is a *folder* (use `degit`); the others are a *single file* (use `curl`).

## Claude Code

Copy the skill into your project (or `~/.claude/skills/` to make it global):

```bash
npx degit mertdogar/super-line/skills/super-line .claude/skills/super-line
```

It activates automatically when you import from `@super-line/*` or mention super-line — no config needed.

## Cursor

Cursor reads rules from `.cursor/rules/*.mdc`. Fetch the condensed guide and prepend Cursor's frontmatter in one step:

```bash
mkdir -p .cursor/rules
{ printf -- '---\ndescription: super-line — typesafe WebSocket contracts (roles + direction)\nalwaysApply: true\n---\n\n'
  curl -fsSL https://raw.githubusercontent.com/mertdogar/super-line/main/skills/super-line/AGENTS.md
} > .cursor/rules/super-line.mdc
```

## GitHub Copilot

Copilot reads `.github/instructions/*.instructions.md`:

```bash
mkdir -p .github/instructions
{ printf -- '---\napplyTo: "**"\n---\n\n'
  curl -fsSL https://raw.githubusercontent.com/mertdogar/super-line/main/skills/super-line/AGENTS.md
} > .github/instructions/super-line.instructions.md
```

## Any other agent (Windsurf, Cline, Codex, Zed, …)

Most newer agents read an `AGENTS.md` at the project root, or can be pointed at any markdown file. Drop the condensed guide in as-is — no frontmatter needed:

```bash
curl -fsSL -o AGENTS.md https://raw.githubusercontent.com/mertdogar/super-line/main/skills/super-line/AGENTS.md
```

If your agent uses a different rules path (e.g. `.windsurfrules`, `.clinerules/`), write it there instead (`curl -fsSL -o <path> …`).

## Keeping it current

The guide tracks the published API. Re-run the command above to refresh after upgrading super-line. The content mirrors these docs, so an agent that can browse the web can also just be pointed at <https://mertdogar.github.io/super-line/>.

> Prefer not to use the terminal? Every file is browsable at [`skills/super-line/`](https://github.com/mertdogar/super-line/tree/main/skills/super-line) — copy its contents into the path your agent expects.
