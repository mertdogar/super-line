// The two Mastra agents — the same supervisor/worker pair as super-harness's examples/web,
// minus the harness: a supervisor that MUST delegate real-world lookups to a `worker` subagent
// whose weather tool hits Open-Meteo live. The delegate tool is hand-rolled here (the harness
// injects its own): its execute() streams the worker INTO THE SAME MESSAGE, nested under the
// delegate call's tool part — see runtime.ts.

import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { gateway } from '@ai-sdk/gateway'
import { z } from 'zod'

export const MODEL = process.env.MODEL ?? process.env.CHAT_MODEL ?? 'anthropic/claude-haiku-4.5'

const weatherTool = createTool({
  id: 'weather',
  description: 'Get the current weather for a city: temperature, humidity, wind, and conditions.',
  inputSchema: z.object({ location: z.string().describe('City name, e.g. "Istanbul"') }),
  outputSchema: z.object({
    location: z.string(),
    temperatureC: z.number(),
    humidity: z.number(),
    windKph: z.number(),
  }),
  execute: async ({ location }) => {
    const geo = (await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
    ).then((r) => r.json())) as { results?: { latitude: number; longitude: number; name: string; country?: string }[] }
    const place = geo.results?.[0]
    if (!place) throw new Error(`Could not find location "${location}"`)
    const wx = (await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m`,
    ).then((r) => r.json())) as { current?: Record<string, number> }
    return {
      location: [place.name, place.country].filter(Boolean).join(', '),
      temperatureC: wx.current?.temperature_2m ?? Number.NaN,
      humidity: wx.current?.relative_humidity_2m ?? Number.NaN,
      windKph: wx.current?.wind_speed_10m ?? Number.NaN,
    }
  },
})

export const worker = new Agent({
  id: 'worker',
  name: 'worker',
  instructions:
    'You are a focused worker. Use your weather tool to get real data, then report a short, concrete result.',
  model: gateway(MODEL),
  tools: { weather: weatherTool },
})

/**
 * The supervisor's delegate tool, mirroring the harness's `makeDelegateTool` shape
 * ({ agentType, task } in, { content, isError } out). The runtime supplies `run` per turn so the
 * worker's stream lands in that turn's message.
 */
export function makeDelegateTool(run: (agentType: string, task: string, toolCallId: string) => Promise<{ content: string; isError: boolean }>) {
  return createTool({
    id: 'delegate',
    description:
      'Delegate a self-contained task to a subagent. It runs headless and returns a final report. Pass the full context it needs.',
    inputSchema: z.object({
      agentType: z.string().describe('Which subagent to run. One of: worker'),
      task: z.string().describe('The complete task/brief for the subagent.'),
    }),
    outputSchema: z.object({ content: z.string(), isError: z.boolean() }),
    execute: async ({ agentType, task }, ctx) => {
      const c = ctx as { agent?: { toolCallId?: string } } | undefined
      const toolCallId = c?.agent?.toolCallId ?? `${agentType}:${task.length}`
      return run(agentType, task, toolCallId)
    },
  })
}

export function makeSupervisor(delegate: ReturnType<typeof makeDelegateTool>): Agent {
  return new Agent({
    id: 'supervisor',
    name: 'supervisor',
    instructions:
      'You coordinate a `worker` subagent that has a live weather tool. ' +
      'For any weather/data question you MUST delegate to the worker via the delegate tool (do not answer from memory), ' +
      'then summarize its report in one short sentence. For everything else, answer conversationally and briefly. ' +
      'Everyone in the channel watches your delegations stream live.',
    model: gateway(MODEL),
    tools: { delegate },
  })
}
