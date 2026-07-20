// One-shot backfill of per-package release tags for the history that predates tagging.
//
//   node scripts/backfill-tags.mjs           # dry run — prints what it would create
//   node scripts/backfill-tags.mjs --apply   # actually create the tags (local only, never pushes)
//
// Versions are recovered from the package.json diff of each `chore(release)` commit, NOT from
// the commit subject: 9 of the 24 release subjects don't name versions at all (e.g. "bump the
// channel-resources train" covers 5 packages). The diff is authoritative.
//
// Every (package, version) pair is checked against the registry — a version that was bumped in
// the repo but never published gets no tag, so tags only ever mark things people can install.

import { execSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 28 })

const liveDirs = readdirSync('packages').filter((d) => existsSync(`packages/${d}/package.json`))
const nameOf = (dir) => JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8')).name

function releasePairs() {
  const commits = sh('git log --format=%H --grep="chore(release)" --reverse').trim().split('\n')
  const pairs = new Map() // `${dir}@${version}` → { dir, version, commit }
  for (const commit of commits) {
    const diff = sh(`git show ${commit} --format="" -- 'packages/*/package.json'`)
    let dir = null
    for (const line of diff.split('\n')) {
      const file = /^\+\+\+ b\/packages\/([^/]+)\/package\.json/.exec(line)
      if (file) {
        dir = file[1]
        continue
      }
      const version = /^\+\s*"version":\s*"([^"]+)"/.exec(line)
      // Last writer wins: if a version appears in two release commits, the later one is the
      // commit that actually shipped it.
      if (version && dir) pairs.set(`${dir}@${version[1]}`, { dir, version: version[1], commit })
    }
  }
  return [...pairs.values()]
}

function publishedVersions(dir) {
  try {
    return new Set(JSON.parse(sh(`npm view ${nameOf(dir)} versions --json 2>/dev/null`)))
  } catch {
    return new Set() // unpublished package → nothing to tag
  }
}

const pairs = releasePairs()
const retired = [...new Set(pairs.map((p) => p.dir))].filter((d) => !liveDirs.includes(d)).sort()
const live = pairs.filter((p) => liveDirs.includes(p.dir))

const registry = new Map()
for (const dir of new Set(live.map((p) => p.dir))) registry.set(dir, publishedVersions(dir))

const existing = new Set(sh('git tag').trim().split('\n').filter(Boolean))
const planned = []
const unpublished = []
for (const p of live) {
  const tag = `${p.dir}-v${p.version}`
  if (existing.has(tag)) continue
  if (!registry.get(p.dir).has(p.version)) {
    unpublished.push(`${p.dir}@${p.version}`)
    continue
  }
  planned.push({ ...p, tag })
}

console.log(`retired packages skipped (${retired.length}): ${retired.join(' ')}`)
console.log(`bumped but never published, skipped (${unpublished.length}): ${unpublished.join(' ') || '—'}`)
console.log(`tags to create: ${planned.length}\n`)
for (const p of planned) console.log(`  ${p.tag.padEnd(38)} → ${p.commit.slice(0, 7)}`)

if (!APPLY) {
  console.log('\ndry run — re-run with --apply to create these tags')
  process.exit(0)
}
for (const p of planned) sh(`git tag ${p.tag} ${p.commit}`)
console.log(`\ncreated ${planned.length} tags (local only — push with: git push origin --tags)`)
