import { createClient } from '@super-line/client'
import { chat } from './examples/react-chat-cluster/src/contract.ts'
const URL = 'ws://localhost:8080/ws'
const mk = (name) => createClient(chat, { url: URL, role: 'user', params: { name } })
async function main() {
  const ada = mk('ada'), grace = mk('grace'), linus = mk('linus')
  ada.subscribe('presence', () => {}); grace.subscribe('presence', () => {}); linus.subscribe('presence', () => {})
  await new Promise((r) => setTimeout(r, 1000))
  await ada.join({ room: 'lobby' }); await grace.join({ room: 'lobby' }); await linus.join({ room: 'general' })
  console.log('joined')
  for (let i = 0; i < 8; i++) {
    await ada.send({ room: 'lobby', text: `hi ${i}` }); await grace.send({ room: 'lobby', text: `hey ${i}` }); await linus.send({ room: 'general', text: `g${i}` })
    await new Promise((r) => setTimeout(r, 1500))
  }
  await new Promise((r) => setTimeout(r, 120000)); ada.close(); grace.close(); linus.close()
}
main().catch((e) => { console.error('SEED ERR', e); process.exit(1) })
