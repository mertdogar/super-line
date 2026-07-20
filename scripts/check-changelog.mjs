// prepublishOnly guard: refuse to publish a package whose committed CHANGELOG.md is stale.
//
// This is what keeps the repo copy and the npm copy identical. The alternative — regenerating
// into the tarball at publish time — would ship a changelog that was never committed, leaving
// the GitHub copy (the one people actually read) permanently a release behind.
//
// Run from a package directory, which is what npm/pnpm does for lifecycle scripts:
//   "prepublishOnly": "tsup && node ../../scripts/check-changelog.mjs"

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { generate } from './changelog.mjs'

const cwd = process.cwd()
const dir = basename(cwd)
const { name, version } = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
const tag = `${dir}-v${version}`

const tagged = (() => {
  try {
    execSync(`git rev-parse -q --verify refs/tags/${tag}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

// Before the release is tagged, the committed changelog was written with `pnpm changelog <pkg>
// <version>`, which files the unreleased commits under this version — so reproduce it the same
// way. Once the tag exists it is the boundary and no override is needed.
const expected = generate(dir, { version: tagged ? undefined : version, capture: true })
const actual = (() => {
  try {
    return readFileSync(resolve(cwd, 'CHANGELOG.md'), 'utf8')
  } catch {
    return ''
  }
})()

if (expected.trim() !== actual.trim()) {
  console.error(
    `\n✗ ${name}: CHANGELOG.md is stale — it does not match the commit history.\n\n` +
      `  Run:  pnpm changelog ${dir}${tagged ? '' : ` ${version}`}\n` +
      `  then commit the result and publish again.\n`,
  )
  process.exit(1)
}
console.log(`✓ ${name}: CHANGELOG.md is current`)
