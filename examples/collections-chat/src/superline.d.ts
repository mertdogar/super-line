// One declaration types every hook in '@super-line/plugin-auth/react' for this app — no factory, no
// destructuring, no generic threading at the call site.
import type { chat } from './contract'

declare module '@super-line/plugin-auth/react' {
  interface Register {
    contract: typeof chat
    role: 'user'
  }
}
