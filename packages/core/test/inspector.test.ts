import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  defineContract,
  classifyContract,
  InspectorContract,
  INSPECTOR_SUBPROTOCOL,
} from '@super-line/core'
import type { Schema, RoleOf } from '@super-line/core'

const api = defineContract({
  shared: {
    clientToServer: { ping: { input: z.void(), output: z.number() } },
    serverToClient: {
      notice: { payload: z.object({ text: z.string() }) },
      feed: { payload: z.object({ text: z.string() }), subscribe: true },
    },
  },
  roles: {
    user: {
      clientToServer: {
        say: { input: z.object({ text: z.string() }), output: z.object({ id: z.string() }) },
      },
      // a server→client request — the `serverRequest` flavor
      serverToClient: { poke: { input: z.object({ n: z.number() }), output: z.boolean() } },
    },
  },
})

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

// InspectorContract is a valid contract with a single reserved role
type _role = Expect<Equal<RoleOf<typeof InspectorContract>, 'inspector'>>

describe('classifyContract', () => {
  it('projects names + flavors, with no schemas when no converter is given', () => {
    const out = classifyContract(api)
    expect(out.shared.clientToServer).toEqual([{ name: 'ping', flavor: 'request' }])
    expect(out.shared.serverToClient).toEqual([
      { name: 'notice', flavor: 'event' },
      { name: 'feed', flavor: 'topic' },
    ])
    expect(out.roles.user?.clientToServer).toEqual([{ name: 'say', flavor: 'request' }])
    expect(out.roles.user?.serverToClient).toEqual([{ name: 'poke', flavor: 'serverRequest' }])
  })

  it('attaches schema projections for every schema when a converter is given', () => {
    const seen: Schema[] = []
    const convert = (sch: Schema) => {
      seen.push(sch)
      return { converted: true }
    }
    const out = classifyContract(api, convert)

    // ping in/out, notice payload, feed payload, say in/out, poke in/out = 8
    expect(seen).toHaveLength(8)

    expect(out.shared.clientToServer[0]).toEqual({
      name: 'ping',
      flavor: 'request',
      input: { converted: true },
      output: { converted: true },
    })
    expect(out.shared.serverToClient[1]).toEqual({
      name: 'feed',
      flavor: 'topic',
      payload: { converted: true },
    })
    expect(out.roles.user?.serverToClient[0]).toEqual({
      name: 'poke',
      flavor: 'serverRequest',
      input: { converted: true },
      output: { converted: true },
    })
  })
})

describe('InspectorContract', () => {
  it('exposes the fixed inspector request surface', () => {
    const cts = InspectorContract.roles.inspector.clientToServer
    expect(Object.keys(cts).sort()).toEqual([
      'getConn',
      'getContract',
      'getNode',
      'getTopology',
      'listCollections',
      'listConnections',
      'queryCollection',
    ])
  })

  it('exposes a live `events` topic', () => {
    expect(InspectorContract.roles.inspector.serverToClient.events.subscribe).toBe(true)
  })

  it('reserves a versioned subprotocol', () => {
    expect(INSPECTOR_SUBPROTOCOL).toBe('superline.inspector.v1')
  })
})
