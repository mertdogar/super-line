// The two Mastra agents — completely vanilla: no factories, no delegate tool here. The engine
// (@super-line/plugin-chat/mastra) injects `delegate` per stream call via toolsets, exactly like
// super-harness — agents stay pure and reusable.

import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { gateway } from '@ai-sdk/gateway'
import { z } from 'zod'

export const MODEL = process.env.MODEL ?? process.env.CHAT_MODEL ?? 'anthropic/claude-haiku-4.5'

// Extended thinking → the model streams reasoning tokens, which the engine maps to reasoning
// parts. Mastra deep-merges defaultOptions under the engine's per-lane stream options, so this
// applies in every lane the agent runs in (supervisor turn or worker delegation).
const thinking = {
  providerOptions: { anthropic: { thinking: { type: 'enabled' as const, budgetTokens: 2048 } } },
}

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
  defaultOptions: thinking,
})

export const supervisor = new Agent({
  id: 'supervisor',
  name: 'supervisor',
  instructions:
    'You coordinate a `worker` subagent that has a live weather tool. ' +
    'For any weather/data question you MUST delegate to the worker via the delegate tool (do not answer from memory), ' +
    'then summarize its report in one short sentence. For everything else, answer conversationally and briefly. ' +
    'Everyone in the channel watches your delegations stream live.',
  model: gateway(MODEL),
  defaultOptions: thinking,
})
