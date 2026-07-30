// One declaration types every module-level hook in '@super-line/react' (and the chat hooks in
// '@super-line/plugin-chat/react') for this app. It holds regardless of which transport this tab
// dialed — the contract sits above the transport seam.
import type { chat } from './contract'

declare module '@super-line/react' {
  interface Register {
    contract: typeof chat
    role: 'user'
  }
}
