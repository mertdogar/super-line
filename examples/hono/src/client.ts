import { createSuperLineClient } from '@super-line/client'
import { webSocketClientTransport } from '@super-line/transport-websocket'
import { demo } from './contract.js'
import type { Cursor, Todo } from './contract.js'
import './styles.css'

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T

const gate = $<HTMLFormElement>('#gate')
const nameInput = $<HTMLInputElement>('#name')
const appEl = $('#app')
const uptimeEl = $('#uptime')
const todoForm = $<HTMLFormElement>('#todo-form')
const todoInput = $<HTMLInputElement>('#todo-input')
const todoList = $('#todo-list')
const cursorLayer = $('#cursors')

gate.addEventListener('submit', (e) => {
  e.preventDefault()
  const name = nameInput.value.trim()
  if (name) start(name)
})

function start(name: string): void {
  gate.hidden = true
  appEl.hidden = false

  const client = createSuperLineClient(demo, {
    transport: webSocketClientTransport({ url: `ws://${location.host}/ws` }),
    role: 'user',
    params: { name },
  })

  let myId = ''
  let latest: Todo[] = []
  client.on('welcome', ({ id }) => {
    myId = id
  })

  // --- uptime card ---
  client.subscribe('uptime', ({ seconds }) => {
    uptimeEl.textContent = formatUptime(seconds)
  })

  // --- todos card ---
  const renderTodos = (items: Todo[]): void => {
    latest = items
    todoList.replaceChildren(
      ...items.map((t) => {
        const li = document.createElement('li')
        if (t.done) li.className = 'done'

        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = t.done
        cb.addEventListener('change', () => void client.toggleTodo({ id: t.id }))

        const span = document.createElement('span')
        span.className = 'text'
        span.textContent = t.text
        span.addEventListener('dblclick', () => editInline(li, span, t))

        const by = document.createElement('em')
        by.textContent = t.by

        const del = document.createElement('button')
        del.textContent = '✕'
        del.addEventListener('click', () => void client.removeTodo({ id: t.id }))

        li.append(cb, span, by, del)
        return li
      }),
    )
  }

  const editInline = (li: HTMLLIElement, span: HTMLElement, t: Todo): void => {
    const input = document.createElement('input')
    input.className = 'edit'
    input.value = t.text
    const commit = (): void => {
      const text = input.value.trim()
      if (text && text !== t.text) void client.editTodo({ id: t.id, text })
      else renderTodos(latest)
    }
    input.addEventListener('blur', commit)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') renderTodos(latest)
    })
    li.replaceChild(input, span)
    input.focus()
  }

  client.subscribe('todos', ({ items }) => renderTodos(items))
  void client.getTodos({}).then(({ items }) => renderTodos(items))

  todoForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = todoInput.value.trim()
    if (!text) return
    todoInput.value = ''
    void client.addTodo({ text })
  })

  // --- cursors card ---
  client.subscribe('cursors', ({ cursors }) => renderCursors(cursors, myId))

  let pending = false
  let lastX = 0
  let lastY = 0
  window.addEventListener('mousemove', (e) => {
    lastX = e.clientX
    lastY = e.clientY
    if (pending) return
    pending = true // throttle the request/response cursor stream to one per frame
    requestAnimationFrame(() => {
      pending = false
      void client.moveCursor({ x: lastX, y: lastY })
    })
  })
}

function renderCursors(list: Cursor[], myId: string): void {
  cursorLayer.replaceChildren(
    ...list
      .filter((c) => c.id !== myId)
      .map((c) => {
        const el = document.createElement('div')
        el.className = 'cursor'
        el.style.transform = `translate(${c.x}px, ${c.y}px)`
        el.style.color = c.color
        const label = document.createElement('span')
        label.textContent = c.name
        el.append(label)
        return el
      }),
  )
}

function formatUptime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':')
}
