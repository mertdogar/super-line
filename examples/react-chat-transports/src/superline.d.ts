// One declaration types every hook in '@super-line/plugin-auth/react' for this app. It holds regardless of
// which transport this tab dialed — the contract sits above the transport seam.
import type { chat } from './contract'

declare module '@super-line/plugin-auth/react' {
  interface Register {
    contract: typeof chat
    role: 'user'
  }
}
