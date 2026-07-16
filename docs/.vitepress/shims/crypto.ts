// Browser shim for the Node `crypto` builtin. The in-page ChatDemo runs the real
// @super-line/plugin-chat server, whose only crypto use is randomUUID — which every
// modern browser provides on globalThis.crypto. Aliased in for `crypto`/`node:crypto`.
export const randomUUID = (): string => globalThis.crypto.randomUUID()
export default { randomUUID }
