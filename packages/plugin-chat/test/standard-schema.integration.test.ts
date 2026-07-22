import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineContract } from '@super-line/core'
import type { InferOut, RowOf } from '@super-line/core'
import { memoryCollections } from '@super-line/collections-memory'
import { authContract } from '@super-line/plugin-auth'
import { auth } from '@super-line/plugin-auth/server'
import { chatContract, messagePartSchema } from '@super-line/plugin-chat'
import { chatClient } from '@super-line/plugin-chat/client'
import { chat } from '@super-line/plugin-chat/server'
import { createHarness } from '../../server/test/harness.js'

// A hand-rolled Standard Schema validator — deliberately NOT zod, and not any shared library:
// the whole point is that plugin-chat must accept a validator it shares no instance with.
type ForeignIssue = { message: string; path?: readonly (string | number)[] }
type Foreign<Out> = {
  '~standard': {
    version: 1
    vendor: string
    validate: (v: unknown) => { value: Out } | { issues: readonly ForeignIssue[] }
    types?: { input: unknown; output: Out }
  }
}
const foreign = <Out>(validate: Foreign<Out>['~standard']['validate']): Foreign<Out> => ({
  '~standard': { version: 1, vendor: 'test-foreign', validate },
})

/** `{ kind: 'usage', tokens: number }`, uppercasing `kind` to prove value replacement (transforms). */
const usageData = foreign<{ kind: string; tokens: number }>((v) => {
  const o = v as Record<string, unknown>
  if (typeof o !== 'object' || o === null) return { issues: [{ message: 'not an object' }] }
  if (o['kind'] !== 'usage') return { issues: [{ message: 'kind must be "usage"', path: ['kind'] }] }
  if (typeof o['tokens'] !== 'number') return { issues: [{ message: 'tokens must be a number', path: ['tokens'] }] }
  return { value: { kind: 'USAGE', tokens: o['tokens'] } }
})

const partRow = (data: unknown) => ({
  id: 'm1:0',
  messageId: 'm1',
  channelId: 'c1',
  idx: 0,
  parent: null,
  done: true,
  lastActivityAt: 1,
  type: 'data',
  data,
})

describe('plugin-chat — Standard Schema bridge', () => {
  it('messagePartSchema accepts a foreign Standard Schema validator for data parts', () => {
    const schema = messagePartSchema(usageData)
    const ok = schema.safeParse(partRow({ kind: 'usage', tokens: 42 }))
    expect(ok.success).toBe(true)
    if (ok.success && ok.data.type === 'data') {
      // the foreign validator's OUTPUT value is committed (transforms apply, like embedded zod did)
      expect(ok.data.data).toEqual({ kind: 'USAGE', tokens: 42 })
    }
  })

  it('foreign issues surface as zod issues under the data path', () => {
    const schema = messagePartSchema(usageData)
    const bad = schema.safeParse(partRow({ kind: 'usage', tokens: 'lots' }))
    expect(bad.success).toBe(false)
    if (!bad.success) {
      const issue = bad.error.issues.find((i) => i.message === 'tokens must be a number')
      expect(issue).toBeDefined()
      expect(issue?.path).toEqual(['data', 'tokens'])
    }
  })

  it('an async foreign validator fails loudly with a descriptive error', () => {
    const asyncSchema = foreign<string>(() => Promise.resolve({ value: 'x' }) as never)
    const schema = messagePartSchema(asyncSchema)
    expect(() => schema.safeParse(partRow('x'))).toThrowError(/async Standard Schema/i)
  })

  it('a same-instance zod schema still behaves exactly as before (fast path)', () => {
    const schema = messagePartSchema(z.object({ kind: z.literal('usage'), tokens: z.number() }))
    expect(schema.safeParse(partRow({ kind: 'usage', tokens: 7 })).success).toBe(true)
    expect(schema.safeParse(partRow({ kind: 'nope' })).success).toBe(false)
  })

  // ── end-to-end: a contract whose content AND data schemas are foreign validators ────────────────
  const upperContent = foreign<string>((v) =>
    typeof v === 'string' && v.length > 0
      ? { value: v.toUpperCase() }
      : { issues: [{ message: 'content must be a non-empty string' }] },
  )

  const app = defineContract({
    roles: { user: {} },
    plugins: [authContract(), chatContract({ content: upperContent, data: usageData })],
  })

  // compile-time proof: RowOf infers the FOREIGN validator's output type with no zod-instance
  // comparison (the TS2589 class from the OMMA handoff cannot occur — Schema is structural)
  function _foreignTypeCheck(): void {
    const _content: RowOf<typeof app, 'messages'>['content'] = 'STRING' as InferOut<typeof upperContent>
    void _content
  }
  void _foreignTypeCheck

  const h = createHarness()
  afterEach(() => h.dispose())

  async function boot() {
    const backend = memoryCollections()
    const authKit = auth({ contract: app, collections: backend, defaultRoles: ['user'] })
    const chatKit = chat({ contract: app })
    const { url } = await h.server(app, {
      nodeKey: 'chat-standard-schema-test',
      authenticate: authKit.authenticate,
      identify: authKit.identify,
      collections: backend,
      plugins: [authKit.plugin, chatKit.plugin],
    })
    return { url, chatKit }
  }

  async function newUser(url: string, email: string) {
    const g = h.client(app, { url, role: 'guest' })
    const { token } = await g.signUp({ email, password: 'passpass', displayName: email })
    g.close()
    return h.client(app, { url, role: 'user', params: { token } })
  }

  it('sendMessage validates and transforms content through the foreign validator', async () => {
    const { url } = await boot()
    const c = await newUser(url, 'ann@x.com')
    const chat = chatClient(c)
    const chan = await chat.createChannel({ name: 'general' })
    const sent = await chat.send(chan.id, 'hello')
    expect(sent.content).toBe('HELLO')
    await expect(chat.send(chan.id, '' as never)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
