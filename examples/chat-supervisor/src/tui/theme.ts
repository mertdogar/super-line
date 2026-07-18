// Ported from super-harness/packages/tui/src/theme.ts with the tool-state vocabulary swapped to
// plugin-chat's real enums (TOOL_STATES = input-streaming | running | done; MESSAGE_STATUSES).

export type ToolState = 'input-streaming' | 'running' | 'done'
export type MsgStatus = 'streaming' | 'complete' | 'aborted' | 'error'

export const COLORS = {
  dim: '#6b7280',
  text: '#d4d4d4',
  accent: '#61afef',
  green: '#98c379',
  red: '#e06c75',
  yellow: '#e5c07b',
  purple: '#c678dd',
  cyan: '#56b6c2',
  border: '#3a3f4b',
  userBorder: '#3b6ea5',
  rowActive: '#2c313a',
  panel: '#1c1f26',
}

export function toolGlyph(state: ToolState | undefined, isError?: boolean): string {
  if (isError) return '✗'
  if (state === 'done') return '✓'
  if (state === 'input-streaming') return '·'
  return '▸'
}

export function toolColor(state: ToolState | undefined, isError?: boolean): string {
  if (isError) return COLORS.red
  if (state === 'done') return COLORS.green
  return COLORS.yellow
}

export function statusColor(status: MsgStatus | undefined): string {
  if (status === 'error' || status === 'aborted') return COLORS.red
  if (status === 'complete') return COLORS.green
  return COLORS.yellow
}

/** A delegation lane's header color, from the anchor tool part's isError/done. */
export function laneColor(isError: boolean, done: boolean): string {
  if (isError) return COLORS.red
  if (done) return COLORS.green
  return COLORS.yellow
}

export function agentGlyph(agentType: string | undefined): string {
  if (agentType === 'editor') return '✎'
  if (agentType === 'worker') return '✦'
  return '◆'
}

export function toolLabel(name: string): string {
  return name.replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
