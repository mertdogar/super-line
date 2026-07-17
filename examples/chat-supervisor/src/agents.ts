// The Mastra agents. The worker is completely vanilla; the supervisor and editor are built by a
// factory because they carry plugin-chat's resource tools (AI SDK `tool()` objects — Mastra's
// `tools:` accepts them directly), which need the bot's live connection. No delegate tool anywhere
// here — the engine (@super-line/plugin-chat/mastra) injects it per stream call via toolsets.

import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { gateway } from '@ai-sdk/gateway'
import type { ToolSet } from 'ai'
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

/** One-line shape notes appended to read/write_resource tool descriptions — the model writes without a read-first round-trip. */
export const RESOURCE_SHAPES: Record<string, string> = {
  canvas:
    '{ title: string, items: Record<id, { x: number, y: number, color: string, text: string }> } — sticky notes on a ~1200x800 board; color is a hex like #fef08a. title is set at creation, leave it alone.',
  doc: '{ title: string, blocks: Record<id, { order: number, text: string }> } — ordered text blocks; order is a number, lowest first. title is set at creation, leave it alone.',
}

/**
 * The supervisor reads the channel's resources (context); the `editor` subagent is the only one
 * that WRITES them — every edit streams as its own delegation card while the canvas updates live
 * in the side pane.
 */
export function makeAgents(tools: { read: ToolSet; edit: ToolSet }): { supervisor: Agent; editor: Agent } {
  const editor = new Agent({
    id: 'editor',
    name: 'editor',
    instructions:
      'You edit the channel\'s shared resources: a "canvas" (sticky notes) and a "doc" (ordered text blocks). ' +
      'Your task names the channelId and the target resource\'s kind + docId — use those exact ids with write_resource. ' +
      '(If the task somehow omits them, list_resources with the channelId to recover them; read_resource when you need current content.) ' +
      'Each write op sets or deletes at an object-key path, e.g. {"path":["items","n-1"],"set":{"x":120,"y":80,"color":"#fef08a","text":"ship it"}}. ' +
      'Mint short unique ids for new items/blocks. Spread canvas notes out (board is ~1200x800; notes are ~176px wide). ' +
      'For doc blocks pick `order` values that slot where you want (lowest renders first). ' +
      'Humans are editing the same doc live — change only what the task asks, then report what you did in one short sentence.',
    model: gateway(MODEL),
    tools: { ...tools.edit },
    defaultOptions: thinking,
  })
  const supervisor = new Agent({
    id: 'supervisor',
    name: 'supervisor',
    instructions:
      'You coordinate two subagents: `worker` has a live weather tool; `editor` edits this channel\'s shared canvas and doc. ' +
      'The channel context message gives you the current channelId and each resource\'s kind + docId. ' +
      'For any weather/data question you MUST delegate to the worker (do not answer from memory). ' +
      'For any request to add/change/remove things on the canvas or doc you MUST delegate to the editor, and the task you give it MUST spell out the channelId and the target resource\'s kind + docId (it starts with no channel context of its own), plus exactly what to change. ' +
      'You may use your own list_resources/read_resource tools to answer questions ABOUT the resources without delegating. ' +
      'Summarize delegation results in one short sentence; answer everything else conversationally and briefly. ' +
      'Everyone in the channel watches your delegations stream live.',
    model: gateway(MODEL),
    tools: { ...tools.read },
    defaultOptions: thinking,
  })
  return { supervisor, editor }
}
