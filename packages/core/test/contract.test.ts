import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineContract, validate } from '@super-line/core'
import type {
  RoleOf,
  Requests,
  Events,
  Topics,
  ServerEvents,
  InferOut,
} from '@super-line/core'

const api = defineContract({
  shared: {
    clientToServer: { ping: { input: z.void(), output: z.number() } },
    serverToClient: { serverNotice: { payload: z.object({ text: z.string() }) } },
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
  serverToServer: {
    rebalance: z.object({ shard: z.number() }),
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
type _userTopics = Expect<Equal<keyof Topics<Api, 'user'>, 'roomFeed'>>
type _agentEvents = Expect<Equal<keyof Events<Api, 'agent'>, 'serverNotice'>>
type _agentTopics = Expect<Equal<keyof Topics<Api, 'agent'>, 'taskAssigned'>>

// inferred member types flow through the merge
type _sendOut = Expect<Equal<InferOut<Requests<Api, 'user'>['sendMessage']['output']>, { id: string }>>
type _topicPayload = Expect<Equal<InferOut<Topics<Api, 'user'>['roomFeed']['payload']>, { text: string }>>

// serverToServer
type _s2s = Expect<Equal<keyof ServerEvents<Api>, 'rebalance'>>

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
