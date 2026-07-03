import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineContract, defineSurface, mergeSurfaces, validate } from '@super-line/core'
import type {
  RoleOf,
  Requests,
  Events,
  Topics,
  SharedTopics,
  InferOut,
} from '@super-line/core'

const api = defineContract({
  shared: {
    clientToServer: { ping: { input: z.void(), output: z.number() } },
    serverToClient: {
      serverNotice: { payload: z.object({ text: z.string() }) },
      broadcast: { payload: z.object({ text: z.string() }), subscribe: true },
    },
  },
  roles: {
    user: {
      clientToServer: {
        sendMessage: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
      serverToClient: {
        messagePosted: { payload: z.object({ id: z.string(), text: z.string() }) },
        roomFeed: { payload: z.object({ text: z.string() }), subscribe: true },
      },
    },
    agent: {
      clientToServer: {
        reportResult: { input: z.object({ taskId: z.string() }), output: z.void() },
      },
      serverToClient: {
        taskAssigned: {
          payload: z.object({ taskId: z.string(), prompt: z.string() }),
          subscribe: true,
        },
      },
    },
  },
})

type Api = typeof api

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// roles
type _roles = Expect<Equal<RoleOf<Api>, 'user' | 'agent'>>

// requests = shared ∪ role
type _userReqs = Expect<Equal<keyof Requests<Api, 'user'>, 'ping' | 'sendMessage'>>
type _agentReqs = Expect<Equal<keyof Requests<Api, 'agent'>, 'ping' | 'reportResult'>>

// serverToClient split: events exclude subscribe:true; topics keep only them
type _userEvents = Expect<Equal<keyof Events<Api, 'user'>, 'serverNotice' | 'messagePosted'>>
type _userTopics = Expect<Equal<keyof Topics<Api, 'user'>, 'roomFeed' | 'broadcast'>>
type _agentEvents = Expect<Equal<keyof Events<Api, 'agent'>, 'serverNotice'>>
type _agentTopics = Expect<Equal<keyof Topics<Api, 'agent'>, 'taskAssigned' | 'broadcast'>>

// inferred member types flow through the merge
type _sendOut = Expect<Equal<InferOut<Requests<Api, 'user'>['sendMessage']['output']>, { id: string }>>
type _topicPayload = Expect<Equal<InferOut<Topics<Api, 'user'>['roomFeed']['payload']>, { text: string }>>

// shared topics are the cluster-bus surface (server.publish/subscribe) and flow into each role's client topics
type _sharedTopics = Expect<Equal<keyof SharedTopics<Api>, 'broadcast'>>

describe('contract (role + direction)', () => {
  it('validates inbound input by schema', async () => {
    const schema = api.roles.user.clientToServer.sendMessage.input
    await expect(validate(schema, { text: 'hi' })).resolves.toEqual({ text: 'hi' })
    await expect(validate(schema, {})).rejects.toThrow()
  })

  it('keeps subscribe:true as a literal flag on topics', () => {
    expect(api.roles.user.serverToClient.roomFeed.subscribe).toBe(true)
    expect('subscribe' in api.roles.user.serverToClient.messagePosted).toBe(false)
  })
})

// ── surface composition ──

// an embedded library's exported fragment, keys prefixed by convention
const libSurface = defineSurface({
  clientToServer: {
    'lib.join': { input: z.object({ threadId: z.string() }), output: z.object({ ok: z.boolean() }) },
  },
  serverToClient: {
    'lib.suspended': { payload: z.object({ threadId: z.string() }) },
    'lib.feed': { payload: z.object({ text: z.string() }), subscribe: true },
  },
})

const hostSurface = defineSurface({
  clientToServer: {
    say: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
  },
  serverToClient: {
    posted: { payload: z.object({ id: z.string() }) },
  },
})

const composed = defineContract({ roles: { user: mergeSurfaces(libSurface, hostSurface) } })
type Composed = typeof composed

// the merged role sees both fragments' requests, and lib.feed survives as a TOPIC
// (defineSurface's const param keeps subscribe:true literal through the merge)
type _mergedReqs = Expect<Equal<keyof Requests<Composed, 'user'>, 'lib.join' | 'say'>>
type _mergedEvents = Expect<Equal<keyof Events<Composed, 'user'>, 'lib.suspended' | 'posted'>>
type _mergedTopics = Expect<Equal<keyof Topics<Composed, 'user'>, 'lib.feed'>>

describe('surface composition (defineSurface + mergeSurfaces)', () => {
  it('merges both directions and defaults a missing direction to {}', () => {
    const merged = mergeSurfaces(libSurface, hostSurface)
    expect(Object.keys(merged.clientToServer)).toEqual(['lib.join', 'say'])
    expect(Object.keys(merged.serverToClient)).toEqual(['lib.suspended', 'lib.feed', 'posted'])
    const oneSided = mergeSurfaces(defineSurface({ clientToServer: { a: { input: z.void(), output: z.void() } } }), {})
    expect(Object.keys(oneSided.clientToServer)).toEqual(['a'])
    expect(oneSided.serverToClient).toEqual({})
  })

  it('a duplicate key is a compile error AND a runtime throw naming the key', () => {
    const dup = defineSurface({
      clientToServer: { 'lib.join': { input: z.void(), output: z.void() } },
    })
    // @ts-expect-error — 'lib.join' collides with libSurface's request
    expect(() => mergeSurfaces(libSurface, dup)).toThrow(/duplicate keys: lib\.join/)
    const dupStc = defineSurface({ serverToClient: { 'lib.suspended': { payload: z.void() } } })
    // @ts-expect-error — 'lib.suspended' collides in serverToClient
    expect(() => mergeSurfaces(libSurface, dupStc)).toThrow(/duplicate keys: lib\.suspended/)
  })

  it('same key in OPPOSITE directions is not a collision', () => {
    const a = defineSurface({ clientToServer: { tick: { input: z.void(), output: z.void() } } })
    const b = defineSurface({ serverToClient: { tick: { payload: z.void() } } })
    const merged = mergeSurfaces(a, b)
    expect(Object.keys(merged.clientToServer)).toEqual(['tick'])
    expect(Object.keys(merged.serverToClient)).toEqual(['tick'])
  })

  it("rejects a role block's extra keys (data belongs outside the merge)", () => {
    const roleBlock = { data: z.object({}), clientToServer: {} }
    // @ts-expect-error — data?: never keeps RoleBlocks out at the type level too
    expect(() => mergeSurfaces(libSurface, roleBlock)).toThrow(/unexpected key 'data'/)
  })

  it('keeps subscribe:true literal at runtime through defineSurface + merge', () => {
    expect(composed.roles.user.serverToClient['lib.feed'].subscribe).toBe(true)
    const schema = composed.roles.user.clientToServer['lib.join'].input
    return expect(validate(schema, { threadId: 't1' })).resolves.toEqual({ threadId: 't1' })
  })
})
