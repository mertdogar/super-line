// One declaration types every module-level hook in '@super-line/react' (and the chat hooks in
// '@super-line/plugin-chat/react') for this app. The web cockpit and the TUI share a contract and
// the `user` role, so a single registration serves both faces.
import type { app } from './contract'

declare module '@super-line/react' {
  interface Register {
    contract: typeof app
    role: 'user'
  }
}
