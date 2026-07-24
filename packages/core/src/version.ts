/** This package's version. Kept in step with package.json by `scripts/check-manifest.mjs`. */
export const VERSION = '0.15.0'

// Two copies of core in one process is the failure that has no symptom: shapes still match so
// TypeScript is happy, the wire is unchanged so nothing disconnects, and only `instanceof` — the
// one operator that cares which copy an object came from — quietly returns false. A server then
// reports a satellite's CONFLICT as INTERNAL. Peer dependencies make the split structurally
// impossible for a normal install; this catches what is left (a consumer monorepo pinning two
// core versions, or a forced `pnpm.overrides`) by having each copy stake the same global symbol.
//
// Same version loading twice is legitimate (a Vite SSR + client pair, ESM alongside CJS) and
// stays silent. Under a bundler honouring this package's `sideEffects: false` the check may be
// dropped; the split it detects only bites server-side, where modules always evaluate.
const KEY = Symbol.for('super-line.core.version')
const registry = globalThis as { [KEY]?: string }
const first = (registry[KEY] ??= VERSION)
if (first !== VERSION) {
  console.warn(
    `[super-line] Two versions of @super-line/core are loaded in this process (${first} and ${VERSION}). ` +
      `They are different classes, so \`instanceof SuperLineError\` fails across them and typed errors ` +
      `degrade to INTERNAL. Install a single @super-line/core — usually by declaring it once at your ` +
      `workspace root, or by removing a pnpm.overrides pin.`,
  )
}
