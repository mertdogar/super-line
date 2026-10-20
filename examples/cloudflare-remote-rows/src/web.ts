import { createSuperLineClient, type LiveRowSet, type RowSetEvent } from '@super-line/client'
import { and, eq, type RowOf } from '@super-line/core'
import type { Outcome, Value } from '@super-line/collections-cloudflare/contract'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { contract } from './contract.js'

type Row = RowOf<typeof contract, 'storeRows'>

const MAX_SHOWN = 300

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const status = $('status')
const log = $<HTMLOListElement>('log')

function note(text: string, warn = false): void {
  const li = document.createElement('li')
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`
  if (warn) li.className = 'warn'
  log.prepend(li)
  while (log.children.length > 200) log.lastElementChild?.remove()
}

function setStatus(text: string, down = false): void {
  status.textContent = text
  status.className = down ? 'down' : ''
}

const client = createSuperLineClient(contract, {
  transport: webSocketClientTransport({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` }),
  role: 'guest',
  // The Durable Object runs no heartbeat (it would never hibernate). The client pings instead, and the platform
  // answers those pings without waking the object.
  keepalive: 30_000,
  onConnect: () => setStatus('connected'),
  onDisconnect: (code) => {
    setStatus('reconnecting…', true)
    note(code === 4409 ? 'resync: the node closed the socket (4409), reconnecting' : `disconnected (${code}), reconnecting`, true)
  },
  // The client resubscribes every live subscription by itself and diffs the fresh snapshot into it.
  onReconnect: () => {
    setStatus('connected')
    note('reconnected: the subscription reads a fresh snapshot')
  },
})

function cell(value: Value | undefined): HTMLTableCellElement {
  const td = document.createElement('td')
  if (value === null || value === undefined) {
    td.textContent = 'NULL'
    td.className = 'null'
  } else if (typeof value === 'object') td.textContent = `<blob ${atob(value.blob).length} bytes>`
  else td.textContent = String(value)
  return td
}

function grid(columns: string[], rows: Array<Array<Value | undefined>>): HTMLTableElement {
  const t = document.createElement('table')
  const head = t.createTHead().insertRow()
  for (const c of columns) head.append(Object.assign(document.createElement('th'), { textContent: c }))
  const body = t.createTBody()
  for (const r of rows.slice(0, MAX_SHOWN)) body.insertRow().append(...r.map(cell))
  return t
}

// ---- write: SQL against a store, straight through the Worker (the node is not involved)

const CREATE = `CREATE TABLE IF NOT EXISTS dishes (id TEXT PRIMARY KEY, name TEXT, price REAL);
INSERT OR IGNORE INTO dishes (id, name, price) VALUES
  ('soup', 'Tomato soup', 6.5),
  ('bread', 'Sourdough', 4),
  ('stew', 'Lamb stew', 14.25);
SELECT * FROM dishes;`

const DISHES = ['Ramen', 'Falafel', 'Pho', 'Paella', 'Pierogi', 'Tacos', 'Biryani', 'Gnocchi']
const tag = () => crypto.randomUUID().slice(0, 6)
const bulk = (n: number) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
INSERT INTO dishes (id, name, price) SELECT '${tag()}-' || i, 'Bulk dish ' || i, (i % 40) + 0.5 FROM n;`

const scripts: Record<string, () => string> = {
  create: () => CREATE,
  insert: () =>
    `INSERT INTO dishes (id, name, price) VALUES ('${tag()}', '${DISHES[Math.floor(Math.random() * DISHES.length)]}', ${(5 + Math.random() * 20).toFixed(2)});`,
  update: () => 'UPDATE dishes SET price = round(price * 1.1, 2) WHERE id = (SELECT id FROM dishes ORDER BY random() LIMIT 1);',
  delete: () => 'DELETE FROM dishes WHERE id = (SELECT id FROM dishes ORDER BY random() LIMIT 1);',
  bulk1000: () => bulk(1000),
  bulk6000: () => bulk(6000),
  drop: () => 'DROP TABLE dishes;',
}

const sqlForm = $<HTMLFormElement>('sql')
const text = $<HTMLTextAreaElement>('text')
const outcomeLine = $('outcome')
const results = $('results')
text.value = CREATE

function fail(message: string): void {
  outcomeLine.textContent = message
  outcomeLine.className = 'error'
}

async function run(): Promise<void> {
  const store = (sqlForm.elements.namedItem('store') as HTMLInputElement).value.trim()
  outcomeLine.textContent = 'running…'
  outcomeLine.className = 'muted'
  results.replaceChildren()
  // The textarea goes as one statement: SQLite runs every statement in it, in one transaction, and returns the
  // last one's rows.
  const res = await fetch(`/stores/${encodeURIComponent(store)}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ statements: [{ sql: text.value }] }),
  })
  if (!res.ok) return fail(`HTTP ${res.status}: ${await res.text()}`)
  const outcome = (await res.json()) as Outcome
  if ('error' in outcome) return fail(outcome.error)
  const [result] = outcome.results
  if (!result) return
  const { rowsRead, rowsWritten } = result.meta
  outcomeLine.textContent = `${result.rows.length} rows returned · the last statement read ${rowsRead} and wrote ${rowsWritten} rows (change log included)`
  if (result.columns.length) results.replaceChildren(grid(result.columns, result.rows))
}

sqlForm.addEventListener('submit', (e) => {
  e.preventDefault()
  run().catch((err: Error) => fail(err.message))
})
document.querySelector('.buttons')!.addEventListener('click', (e) => {
  const script = (e.target as HTMLElement).dataset.script
  if (!script || !scripts[script]) return
  text.value = scripts[script]()
  run().catch((err: Error) => fail(err.message))
})

// ---- read: one live subscription to a store's table, served by the node

const subForm = $<HTMLFormElement>('sub')
const count = $('count')
const rowsView = $('rows')
let current: LiveRowSet<Row> | undefined

const describe = (ev: RowSetEvent<Row>) => `${ev.type} ${ev.id}${ev.row ? ` ${JSON.stringify(ev.row.data)}` : ''}`
function summary(events: RowSetEvent<Row>[]): string {
  const by = new Map<string, number>()
  for (const ev of events) by.set(ev.type, (by.get(ev.type) ?? 0) + 1)
  return [...by].map(([type, n]) => `${n} ${type}`).join(', ')
}

function watch(storeId: string, tableName: string): void {
  current?.close()
  // storeId and table must be pinned with eq(): they tell the node which store, and which of its tables, to read.
  const sub = (current = client.collection('storeRows').subscribe({ filter: and(eq('storeId', storeId), eq('table', tableName)) }))
  rowsView.replaceChildren()
  count.textContent = `subscribing to ${storeId} / ${tableName}…`

  const paint = () => {
    const rows = sub.rows()
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r.data)))]
    rowsView.replaceChildren(grid(columns, rows.map((r) => columns.map((c) => r.data[c]))))
    const shown = rows.length > MAX_SHOWN ? `, showing the first ${MAX_SHOWN}` : ''
    count.textContent = `${storeId} / ${tableName}: ${rows.length} rows${shown}`
  }

  // Changes arrive one row at a time; a bulk write would flood the log, so each 50ms batch is one line.
  let batch: RowSetEvent<Row>[] = []
  const flush = () => {
    const events = batch
    batch = []
    if (sub !== current) return
    if (events.length <= 5) for (const ev of events) note(describe(ev))
    else note(`${events.length} changes: ${summary(events)}`)
    paint()
  }

  sub.ready.then(
    () => {
      if (sub !== current) return
      note(`subscribed to ${storeId} / ${tableName}: a snapshot of ${sub.rows().length} rows`)
      paint()
      sub.subscribe((ev) => {
        if (batch.push(ev) === 1) setTimeout(flush, 50)
      })
    },
    (err: Error) => {
      if (sub !== current) return
      count.textContent = `subscribe failed: ${err.message}`
      note(`subscribe failed: ${err.message}`, true)
    },
  )
}

subForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const form = new FormData(subForm)
  watch(String(form.get('store')).trim(), String(form.get('table')).trim())
})
subForm.requestSubmit()
