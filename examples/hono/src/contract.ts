import { z } from 'zod'
import { defineContract } from '@super-line/core'

const todo = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
  by: z.string(),
})

const cursor = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  color: z.string(),
})

// One contract, three live cards + a REST→WS bridge. Single `user` role; everything
// lives in `shared` so `srv.publish` reaches every connection.
export const demo = defineContract({
  shared: {
    clientToServer: {
      getTodos: { input: z.object({}), output: z.object({ items: z.array(todo) }) },
      addTodo: { input: z.object({ text: z.string().min(1) }), output: z.object({ id: z.string() }) },
      toggleTodo: { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
      editTodo: {
        input: z.object({ id: z.string(), text: z.string().min(1) }),
        output: z.object({ ok: z.boolean() }),
      },
      removeTodo: { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
      // High-frequency, but client→server is request/response only — throttled on the client.
      moveCursor: { input: z.object({ x: z.number(), y: z.number() }), output: z.object({ ok: z.boolean() }) },
    },
    serverToClient: {
      // one-time push so a tab learns its server-assigned identity (id + color from ctx)
      welcome: { payload: z.object({ id: z.string(), color: z.string() }) },
      uptime: { payload: z.object({ seconds: z.number() }), subscribe: true },
      todos: { payload: z.object({ items: z.array(todo) }), subscribe: true },
      cursors: { payload: z.object({ cursors: z.array(cursor) }), subscribe: true },
    },
  },
  roles: {
    user: {},
  },
})

export type Todo = z.infer<typeof todo>
export type Cursor = z.infer<typeof cursor>
