// prepublishOnly guard: refuse to publish while any package hard-depends on another @super-line
// package, or peers on one with a range that can go stale.
//
// A regular `dependency` on a workspace sibling publishes as a caret, and under 0.x `^0.14.1`
// means `>=0.14.1 <0.15.0` — so the day core's minor moves and only some packages are
// republished, npm installs two physical copies of core. Everything still typechecks (structural
// typing) and the wire still works (PROTOCOL unchanged); only `instanceof` notices, which is how
// a satellite's CONFLICT reaches a client as INTERNAL. A peer cannot be duplicated that way.
//
// The ranges are written out by hand rather than left as `workspace:^` for the same reason:
// `workspace:^` publishes as `^0.14.1`, so every core minor would warn on every satellite that
// had not been republished yet, and a wall of false warnings is how real ones get ignored.
// `>=0.14.0 <1.0.0` warns only when a consumer is genuinely behind. A floor that lags the
// dependee stays satisfied, so nothing here has to be kept in sync — raise a floor only when a
// package actually starts needing a newer sibling.
//
// Runs repo-wide from any package directory, which is what npm/pnpm does for lifecycle scripts:
//   "prepublishOnly": "tsup && node ../../scripts/check-changelog.mjs && node ../../scripts/check-manifest.mjs"

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

const pkgs = globSync('packages/*/package.json', { cwd: root })
  .sort()
  .map((rel) => ({ rel, ...read(resolve(root, rel)) }))
const versionOf = new Map(pkgs.map((p) => [p.name, p.version]))

const internal = (block) => Object.entries(block ?? {}).filter(([k]) => versionOf.has(k))
const parse = (v) => v.split('.').map(Number)
const gte = (a, b) => {
  const [x, y, z] = parse(a)
  const [i, j, k] = parse(b)
  return x !== i ? x > i : y !== j ? y > j : z >= k
}

const errors = []
for (const pkg of pkgs) {
  for (const [dep] of internal(pkg.dependencies)) {
    errors.push(`${pkg.name}: "${dep}" is in dependencies — internal packages must be peerDependencies.`)
  }
  for (const [dep, range] of internal(pkg.peerDependencies)) {
    if (!pkg.devDependencies?.[dep]) {
      errors.push(`${pkg.name}: peers on "${dep}" without a devDependencies mirror — the workspace cannot link it.`)
    }
    const m = /^>=(\d+\.\d+\.\d+) <1\.0\.0$/.exec(range)
    if (!m) {
      errors.push(`${pkg.name}: peer range on "${dep}" is "${range}" — must be ">=<x.y.0> <1.0.0".`)
    } else if (!gte(versionOf.get(dep), m[1])) {
      errors.push(`${pkg.name}: peer range on "${dep}" is "${range}", which ${versionOf.get(dep)} does not satisfy.`)
    }
  }
}

const core = pkgs.find((p) => p.name === '@super-line/core')
const declared = /VERSION = '([^']+)'/.exec(readFileSync(resolve(root, 'packages/core/src/version.ts'), 'utf8'))?.[1]
if (declared !== core.version) {
  errors.push(`@super-line/core: src/version.ts says ${declared}, package.json says ${core.version}.`)
}

if (errors.length) {
  console.error(`\n✗ manifest check failed:\n\n${errors.map((e) => `  ${e}`).join('\n')}\n`)
  process.exit(1)
}
console.log(`✓ ${pkgs.length} manifests: no internal hard dependencies, peer ranges wide`)
