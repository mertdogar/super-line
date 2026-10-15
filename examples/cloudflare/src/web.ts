import { createSuperLineClient } from '@super-line/client'
import { authClient } from '@super-line/plugin-auth/client'
import { chatClient, type ChatClient } from '@super-line/plugin-chat/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { contract } from './contract.js'

// The node lives behind the Worker's /ws route; any other path is a static file.
const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

const auth = authClient({
  authedRole: 'user',
  connect: ({ role, params }) =>
    createSuperLineClient(contract, {
      transport: webSocketClientTransport({ url }),
      role: role as 'user',
      params,
      // The Durable Object runs no heartbeat (it would never hibernate). The client pings instead, and the
      // platform answers those pings without waking the object.
      keepalive: 30_000,
    }),
})

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const authForm = $<HTMLFormElement>('auth')
const chatView = $<HTMLDivElement>('chat')
const status = $<HTMLParagraphElement>('status')
const list = $<HTMLUListElement>('messages')

authForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const form = new FormData(authForm)
  const email = String(form.get('email'))
  const password = String(form.get('password'))
  const signUp = (e.submitter as HTMLButtonElement | null)?.name === 'signUp'
  const done = signUp
    ? auth.signUp({ email, password, displayName: String(form.get('displayName')) || email })
    : auth.signIn({ email, password })
  done.catch((err: Error) => (status.textContent = err.message))
})
$('signOut').addEventListener('click', () => void auth.signOut())

let chat: ChatClient<typeof contract> | undefined
const stops: Array<() => void> = []

function render(): void {
  const { status: s, userId, displayName } = auth.state
  status.textContent = s === 'authed' ? `signed in as ${displayName}` : 'not signed in'
  authForm.hidden = s === 'authed'
  chatView.hidden = s !== 'authed'
  if (s === 'authed' && !chat) open(userId)
  if (s !== 'authed' && chat) close()
}

// #general appears once the server has added this user to it (on their first connection).
function open(userId: string | null): void {
  const c = (chat = chatClient(auth.client, { userId }))
  const channels = c.channels()
  stops.push(() => channels.close())
  stops.push(
    channels.subscribe(() => {
      const general = channels.rows().find((ch) => ch.name === 'general')
      if (general && !send.dataset.channel) watch(c, general.id)
    }),
  )
}

const send = $<HTMLFormElement>('send')
send.addEventListener('submit', (e) => {
  e.preventDefault()
  const input = send.elements.namedItem('text') as HTMLInputElement
  if (chat && send.dataset.channel) void chat.send(send.dataset.channel, input.value)
  input.value = ''
})

function watch(c: ChatClient<typeof contract>, channelId: string): void {
  send.dataset.channel = channelId
  const messages = c.messages(channelId)
  const members = c.members(channelId)
  const paint = () => {
    const names = new Map(members.rows().map((m) => [m.userId, m.displayName]))
    list.replaceChildren(
      ...messages.rows().map((m) => {
        const li = document.createElement('li')
        const who = document.createElement('b')
        who.textContent = names.get(m.authorId) ?? '…'
        li.append(who, String(m.content))
        return li
      }),
    )
  }
  stops.push(messages.subscribe(paint), members.subscribe(paint), () => messages.close(), () => members.close())
}

function close(): void {
  for (const stop of stops.splice(0)) stop()
  chat?.close()
  chat = undefined
  delete send.dataset.channel
  list.replaceChildren()
}

auth.subscribe(render)
void auth.ready.then(render)
