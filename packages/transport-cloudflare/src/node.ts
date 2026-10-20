import { DurableObject } from 'cloudflare:workers'
import type { ServerTransport } from '@super-line/core'
import { cloudflareServerTransport, type CloudflareServerTransport } from './transport.js'

/** Spread into `createSuperLineServer`'s options: the Durable Object transport and a `nodeKey` stable per object. */
export interface DurableNodeBase {
  transports: ServerTransport[]
  nodeKey: string
}

/** The class {@link createDurableNode} returns: a Durable Object exposing its transport and its server. */
export type DurableNodeClass<Env, S> = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & { readonly transport: CloudflareServerTransport; readonly server: S }

/**
 * A Durable Object class that is one super-line node. `build` runs in the constructor — on first use AND on every
 * wake from hibernation — and returns the server, built with `...base`. The class forwards `fetch` and the
 * WebSocket handlers to the transport and resumes every surviving connection before any event is delivered.
 * Extend it and export the subclass under the name your wrangler config binds; `this.server` is the server.
 *
 * ```ts
 * export class Node extends createDurableNode((ctx, env: Env, base) =>
 *   createSuperLineServer(contract, { ...base, authenticate }).implement({ user: { ping: async () => 'pong' } }),
 * ) {}
 * ```
 */
export function createDurableNode<Env = Cloudflare.Env, S extends { readonly ready: Promise<void> } = { readonly ready: Promise<void> }>(
  build: (ctx: DurableObjectState, env: Env, base: DurableNodeBase) => S,
): DurableNodeClass<Env, S> {
  return class DurableNode extends DurableObject<Env> {
    readonly transport: CloudflareServerTransport
    readonly server: S

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      this.transport = cloudflareServerTransport(ctx)
      this.server = build(ctx, env, { transports: [this.transport], nodeKey: ctx.id.toString() })
      void ctx.blockConcurrencyWhile(() => this.server.ready)
    }

    override fetch(request: Request): Promise<Response> {
      return this.transport.fetch(request)
    }
    override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
      this.transport.webSocketMessage(ws, message)
    }
    override webSocketClose(ws: WebSocket, code: number, reason: string): void {
      this.transport.webSocketClose(ws, code, reason)
    }
    override webSocketError(ws: WebSocket, error: unknown): void {
      this.transport.webSocketError(ws, error)
    }
  }
}

/**
 * Forward a Worker request to the Durable Object that is the node. One named object per deployment by default;
 * pass `name` to pick one per request (a tenant from the host or path).
 */
export function routeToNode<T extends Rpc.DurableObjectBranded | undefined = undefined>(
  request: Request,
  namespace: DurableObjectNamespace<T>,
  opts: { name?: (request: Request) => string } = {},
): Promise<Response> {
  return namespace.getByName(opts.name?.(request) ?? 'super-line').fetch(request)
}
