// Chat-flavored COMMANDS table — same shape as the harness dispatch.ts so the ported Prompt's
// popover/help wiring works unchanged. Resource commands (canvas/doc/resources) arrive with the
// resource pane in a later ticket.

export interface Command {
  name: string
  arg?: string
  desc: string
  takesArg: boolean
}

export const COMMANDS: Command[] = [
  { name: 'channels', desc: 'list / switch channels', takesArg: false },
  { name: 'new', arg: 'name', desc: 'create a channel', takesArg: true },
  { name: 'who', desc: 'members in this channel', takesArg: false },
  { name: 'cancel', desc: 'stop the streaming turn', takesArg: false },
  { name: 'resources', desc: 'toggle the resource pane', takesArg: false },
  { name: 'canvas', desc: 'open the canvas', takesArg: false },
  { name: 'doc', desc: 'open the doc', takesArg: false },
  { name: 'session', desc: 'connection info', takesArg: false },
  { name: 'login', desc: 'switch account', takesArg: false },
  { name: 'help', desc: 'show commands', takesArg: false },
  { name: 'quit', desc: 'exit', takesArg: false },
]
