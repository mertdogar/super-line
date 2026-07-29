import * as z from 'zod'
import { defineContract, type CrdtCollectionName, type RowOf } from '@super-line/core'
import { authContract } from '@super-line/plugin-auth'
import { chatContract } from '@super-line/plugin-chat'

/**
 * The whole contract. Identity comes from `@super-line/plugin-auth` (users, credentials, sessions,
 * presence + the `guest` role); the durable chat model — channels, memberships, messages — comes from
 * `@super-line/plugin-chat`. Almost nothing here is the app's own: the wire the browser dials is not
 * contract surface, and the per-channel document is a plugin-chat **channel resource**, so its registry
 * row, its access rules and its lifecycle all come from the plugin too.
 *
 * The `user` role is the one block that isn't a plugin: plugin-chat puts its requests on `shared` and
 * plugin-auth only contributes `guest`, so the host still names the authenticated role it connects as.
 * Its `env` (ADR-0012) is the server-vended, client-visible slice — here it carries the PUBLIC half of a
 * bearer assertion's payload, which is the only way a browser holding a *sealed* token learns what is in
 * it. The sealed half never appears here, because `env` is by definition what the client may see.
 *
 * The two `awareness` keys are the app's ONE piece of hand-written surface, and they are here for a
 * reason worth knowing: a document's *content* is a CRDT and rides the collection machinery, but the
 * carets drawn over it are not. Yjs awareness is a separate protocol — it never travels on a document
 * update — and it is deliberately ephemeral, so persisting it would be wrong. It therefore needs a plain
 * ephemeral broadcast, which is what a request-plus-event over a room is.
 */
export const chat = defineContract({
  shared: {
    serverToClient: {
      /**
       * Someone's caret/selection. Never persisted, never replayed to a late joiner.
       *
       * On `shared` rather than on `user` because a room is a mixed-role group, so only a shared event can
       * be broadcast to one — the type system says so, and it is right to: a room cannot know that every
       * member happens to hold the same role.
       */
      awareness: { payload: z.object({ channelId: z.string(), update: z.string() }) },
    },
  },
  roles: {
    user: {
      env: z.object({ workspace: z.string() }),
      clientToServer: {
        /**
         * Publish my caret/selection to everyone viewing this channel's document. `update` is base64.
         * Stays on `user`, not `shared`: a signed-out browser has no caret to show and no business
         * addressing a room.
         */
        awarenessUpdate: {
          input: z.object({ channelId: z.string(), update: z.string() }),
          output: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
  collections: {
    /**
     * The per-channel document. Its schema is empty and its ingress validation is OFF — both because the
     * content lives in a **native root**, a Yjs type bound beside the described root, which is the only way
     * to hold text that merges per character rather than per field. Nothing in the described root means
     * nothing for a schema to check, and validating a document per keystroke is unaffordable anyway (the
     * check has to rebuild the whole document to run).
     *
     * Everything you would normally put in that schema — title, author, timestamps — lives instead on the
     * plugin's `resources` row for this document, which is validated, queryable and policy-gated.
     */
    notes: { schema: z.object({}), crdt: { mode: 'document', validate: false } },
  },
  plugins: [authContract(), chatContract()],
})

/** Typed rows, derived from the merged contract — one source of truth for server + client. */
export type User = RowOf<typeof chat, 'users'>
export type Channel = RowOf<typeof chat, 'channels'>
export type Membership = RowOf<typeof chat, 'memberships'>
export type Message = RowOf<typeof chat, 'messages'>
export type UserPresence = RowOf<typeof chat, 'userPresence'>
/** The registry row for a channel resource — the document's validated, queryable half. */
export type Resource = RowOf<typeof chat, 'resources'>

/** The CRDT collections this contract declares — what `useDoc` accepts as a name. */
export type CrdtName = CrdtCollectionName<typeof chat>

/** The resource kind, and the Yjs root the editor binds to. Both halves must agree, so neither is inlined. */
export const NOTE_KIND = 'note'
export const NOTE_FIELD = 'body'
