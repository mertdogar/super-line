// Argv/env config for the TUI (harness config.ts shape). The web client derives its URL from
// location.hostname; the terminal has no location, so the URL comes from --url / env / a default.
// The headless fields (ticket 08) live here too so the entry split reads one parsed config.

import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_URL = 'ws://localhost:8792/super-line'

function option(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  const prefix = `${flag}=`
  const hit = argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag)
}

export interface Config {
  url: string
  /** Where the access token is cached so restarts reconnect without a login. */
  cachePath: string
  /** Headless stdin/stdout shell instead of the OpenTUI cockpit. `--headless` OR a non-TTY stdout. */
  headless: boolean
  /** Pure-JSONL output (curated event types) instead of the human marker protocol. */
  json: boolean
  /** The channel to land on at boot, by name (defaults to the first visible channel). */
  channel?: string
  /** Session-token override (beats the cache file); also from CHAT_SUPERVISOR_TOKEN. */
  token?: string
  /** A control FIFO to read commands from instead of stdin (mkfifo + reopen loop). */
  control?: string
  /** Where oversized payloads spill in HUMAN mode. Default /tmp/chat-supervisor-tui-<pid>. */
  spillDir: string
}

export function parseConfig(argv: string[] = process.argv.slice(2)): Config {
  const url = option(argv, '--url') ?? process.env.CHAT_SUPERVISOR_URL ?? DEFAULT_URL
  const cachePath =
    option(argv, '--cache') ?? process.env.CHAT_SUPERVISOR_CACHE ?? join(homedir(), '.chat-supervisor-tui.json')
  // Piping the binary's output (chat-supervisor | tee log) auto-selects headless — the behavior you
  // want for CI/scripting without an explicit flag.
  const headless = hasFlag(argv, '--headless') || !process.stdout.isTTY
  return {
    url,
    cachePath,
    headless,
    json: hasFlag(argv, '--json'),
    channel: option(argv, '--channel'),
    // `|| undefined` so an empty env var (CHAT_SUPERVISOR_TOKEN=) reads as absent, not as a "" token
    token: (option(argv, '--token') ?? process.env.CHAT_SUPERVISOR_TOKEN) || undefined,
    control: option(argv, '--control'),
    spillDir: option(argv, '--spill-dir') ?? join('/tmp', `chat-supervisor-tui-${process.pid}`),
  }
}

export const config = parseConfig()
