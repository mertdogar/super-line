// Regenerate CHANGELOG.md files from the conventional-commit history.
//
//   pnpm changelog                  # every package + the root aggregate
//   pnpm changelog react            # one package
//   pnpm changelog react 0.9.1      # one package, treating unreleased work as 0.9.1
//                                   # (use before the tag exists, i.e. while cutting a release)
//
// Release boundaries are the `<pkg>-v<version>` tags. Each package is scoped by running
// git-cliff from its own directory, which limits commits to ones touching that path.

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLIFF = resolve(ROOT, 'node_modules/.bin/git-cliff')
const CONFIG = resolve(ROOT, 'cliff.toml')

const [only, asVersion] = process.argv.slice(2)

export function packageDirs() {
  return readdirSync(resolve(ROOT, 'packages')).filter((d) =>
    existsSync(resolve(ROOT, 'packages', d, 'package.json')),
  )
}

/** Generate one package's changelog. Returns the markdown; writes it unless `capture` is set. */
export function generate(dir, { version, capture = false } = {}) {
  const cwd = resolve(ROOT, 'packages', dir)
  const args = [`--config ${CONFIG}`, `--tag-pattern "^${dir}-v[0-9]"`]
  // --tag names the version that unreleased commits belong to, so a changelog can be written
  // before the tag exists (the release commit and its tag land together, afterwards).
  if (version) args.push(`--tag ${dir}-v${version}`)
  if (!capture) args.push('-o CHANGELOG.md')
  return execSync(`${CLIFF} ${args.join(' ')}`, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
}

/**
 * The root aggregate needs a date heading, not a tag heading: a release commit carries several
 * tags (react-v0.9.1, plugin-chat-v0.6.2, control-center-v0.10.5 all point at one commit), so
 * heading the section with whichever tag won would file two packages' changes under a third's
 * version. Derived from cliff.toml at runtime so the commit_parsers can never drift apart.
 */
function rootConfig() {
  const swapped = readFileSync(CONFIG, 'utf8').replace(
    /^.*\{# ROOT-HEADING #\}$/m,
    '## {{ timestamp | date(format="%Y-%m-%d") }}',
  )
  const path = resolve(ROOT, 'node_modules/.cache/cliff-root.toml')
  mkdirSync(resolve(ROOT, 'node_modules/.cache'), { recursive: true })
  writeFileSync(path, swapped)
  return path
}

function generateRoot() {
  // No path filter and no per-package tag pattern: every release tag is a boundary, giving the
  // "what's new in super-line lately" view.
  execSync(`${CLIFF} --config ${rootConfig()} -o CHANGELOG.md`, { cwd: ROOT, stdio: 'inherit' })
}

if (process.argv[1] === import.meta.filename) {
  if (only) {
    generate(only, { version: asVersion })
    console.log(`wrote packages/${only}/CHANGELOG.md${asVersion ? ` (as ${asVersion})` : ''}`)
  } else {
    for (const dir of packageDirs()) generate(dir)
    generateRoot()
    console.log(`wrote ${packageDirs().length} package changelogs + the root aggregate`)
  }
}
