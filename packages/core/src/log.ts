import { configureSync, getConsoleSink, type LogLevel } from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { JWT_PATTERN, redactByField, redactByPattern } from '@logtape/redaction'

/**
 * The category root every super-line logger hangs off. Packages call
 * `getLogger(['super-line', '<pkg>', '<subsystem>'])`; a host filters `['super-line']` (or a subsystem).
 */
export const LOG_ROOT = 'super-line'

/**
 * Field-name patterns redacted by default (matched at any nesting depth). Curated for super-line rather than
 * LogTape's broad `DEFAULT_REDACT_FIELDS`, whose `/auth/i` would strip the very fields we log for diagnostics
 * (`authMethod`, `authId`) and whose bare `/key/i` would strip `nodeKey`. This targets actual secret-bearing
 * names — plaintext passwords, minted tokens/keys, JWEs, credentials, PII email — while letting identifiers
 * through. (Per ADR-0017 we also never attach a raw minted secret as its own prop; this is defense-in-depth
 * for the rich objects — handshakes, rows — that a debug log may carry.)
 */
export const SUPER_LINE_REDACT_FIELDS = [
  /password/i, // password, passwordHash
  /passcode/i,
  /passphrase/i,
  /secret/i,
  /token/i, // token, accessToken
  /jwt/i,
  /apiKey/i,
  /^key$/i, // the raw minted key field, without matching nodeKey
  /upstreamKey/i,
  /credential/i,
  /signature/i,
  /sealed/i,
  /email/i, // PII
]

export interface EnableLoggingOptions {
  /** Lowest level shown for the `['super-line']` category. Default `'debug'`. */
  level?: LogLevel
  /**
   * Strip secrets before they reach the console (default `true`): field-name redaction over the structured
   * properties plus JWT-pattern redaction over the formatted text. Set `false` only for trusted local runs.
   */
  redact?: boolean
}

/**
 * Turn on super-line's internal logging to a pretty, **secret-redacting** console — the one-line debug switch.
 *
 * ```ts
 * import { enableSuperLineLogging } from '@super-line/core'
 * enableSuperLineLogging({ level: 'debug' })
 * ```
 *
 * This calls LogTape's `configureSync()`, which owns a **single process-global** configuration. So use this
 * **or** your own `configure()`, never both — calling both has the later one replace the earlier. An app that
 * manages LogTape itself should instead add a `['super-line']` logger to its own `configure()` (and wrap its
 * sink in `redactByField` — see docs/how-to/debugging-with-logs.md), rather than call this.
 *
 * `reset: true` makes repeated calls idempotent (last call wins) instead of throwing `ConfigError`.
 */
export function enableSuperLineLogging(opts: EnableLoggingOptions = {}): void {
  const { level = 'debug', redact = true } = opts
  const formatter = redact ? redactByPattern(getPrettyFormatter(), [JWT_PATTERN]) : getPrettyFormatter()
  const consoleSink = getConsoleSink({ formatter })
  const sink = redact ? redactByField(consoleSink, SUPER_LINE_REDACT_FIELDS) : consoleSink
  configureSync({
    reset: true,
    sinks: { console: sink },
    loggers: [
      { category: [LOG_ROOT], lowestLevel: level, sinks: ['console'] },
      // keep LogTape's own meta-warnings visible, but only warnings+ (not its per-config info chatter)
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: ['console'] },
    ],
  })
}
