import { afterEach, describe, expect, it } from 'vitest'
import { configureSync, getLogger, resetSync } from '@logtape/logtape'
import { redactByField } from '@logtape/redaction'
import { createLogRecorder } from '@logtape/testing'
import { enableSuperLineLogging, SUPER_LINE_REDACT_FIELDS } from '@super-line/core'

afterEach(() => resetSync())

describe('enableSuperLineLogging', () => {
  it('wires the [super-line] category at the requested level (no output emitted)', () => {
    enableSuperLineLogging({ level: 'info' })
    const log = getLogger(['super-line', 'server', 'conn'])
    expect(log.isEnabledFor('info')).toBe(true)
    expect(log.isEnabledFor('warning')).toBe(true)
    expect(log.isEnabledFor('debug')).toBe(false) // below the configured floor
  })

  it('is idempotent — a second call re-levels without throwing (reset: true)', () => {
    enableSuperLineLogging({ level: 'info' })
    enableSuperLineLogging({ level: 'trace' }) // would throw ConfigError without reset
    expect(getLogger(['super-line', 'client', 'reconnect']).isEnabledFor('trace')).toBe(true)
  })
})

describe('SUPER_LINE_REDACT_FIELDS', () => {
  it('strips secret-bearing properties (jwt/apiKey/password/upstreamKey/sealed)', () => {
    const recorder = createLogRecorder()
    configureSync({
      reset: true,
      sinks: { rec: redactByField(recorder.sink, SUPER_LINE_REDACT_FIELDS) },
      loggers: [
        { category: ['super-line'], lowestLevel: 'trace', sinks: ['rec'] },
        { category: ['logtape', 'meta'], sinks: [] },
      ],
    })

    getLogger(['super-line', 'plugin-auth', 'authn']).debug('resolved {authMethod}', {
      authMethod: 'jwt',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.secret.sig',
      apiKey: 'slp_supersecret',
      password: 'correct-horse',
      upstreamKey: 'sk-live-7f3a-9c21',
      sealed: { upstreamKey: 'sk-live' },
      userId: 'u-123', // NOT a secret — must survive
    })

    const rec = recorder.records.at(-1)!
    const props = rec.properties as Record<string, unknown>
    expect(props.userId).toBe('u-123') // non-secret preserved
    expect(props.authMethod).toBe('jwt') // non-secret preserved
    // every secret value is gone from the recorded properties (redactByField strips the whole field)
    const serialized = JSON.stringify(props)
    for (const secret of ['eyJhbGciOiJIUzI1NiJ9', 'slp_supersecret', 'correct-horse', 'sk-live']) {
      expect(serialized).not.toContain(secret)
    }
  })
})
