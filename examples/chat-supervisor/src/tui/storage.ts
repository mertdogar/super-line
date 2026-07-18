// A file-backed TokenStorage for plugin-auth: the browser default persists to localStorage, which
// the terminal has no equivalent of, so the session token lands in a 0600 JSON file and restarts
// reconnect silently.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { TokenStorage } from '@super-line/plugin-auth/client'

export function fileStorage(path: string): TokenStorage {
  return {
    get() {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { token?: string }
        return parsed.token ?? null
      } catch {
        return null
      }
    },
    set(token) {
      if (!token) {
        try {
          rmSync(path)
        } catch {
          // absent already — nothing to clear
        }
        return
      }
      writeFileSync(path, JSON.stringify({ token }), { mode: 0o600 })
    },
  }
}
