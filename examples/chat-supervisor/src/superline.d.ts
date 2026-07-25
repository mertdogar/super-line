// One declaration types every hook in '@super-line/plugin-auth/react' for this app. The web cockpit and the
// TUI share a contract and the `user` role, so a single registration serves both faces.
import type { app } from './contract'

declare module '@super-line/plugin-auth/react' {
  interface Register {
    contract: typeof app
    role: 'user'
  }
}
