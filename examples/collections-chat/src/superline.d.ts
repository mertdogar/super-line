// One declaration types every module-level hook in '@super-line/react' (and the chat hooks in
// '@super-line/plugin-chat/react') for this app — no factory, no destructuring, no generic threading.
import type { chat } from './contract'

declare module '@super-line/react' {
  interface Register {
    contract: typeof chat
    role: 'user'
  }
}
