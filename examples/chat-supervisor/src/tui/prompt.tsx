// Ported from super-harness/packages/tui/src/prompt.tsx nearly verbatim. `onFocusPane` (Tab on an
// empty buffer → resource pane) is kept as an optional seam for the pane ticket; unused here.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoxRenderable, KeyEvent, TextareaRenderable } from '@opentui/core'
import { COMMANDS, type Command } from './commands'
import { COLORS } from './theme'

interface Anchor {
  x: number
  y: number
  width: number
}

function slashToken(text: string): string | null {
  if (!text.startsWith('/') || text.includes(' ')) return null
  return text.slice(1).toLowerCase()
}

export function Prompt({
  placeholder,
  focused,
  onSubmit,
  onFocusPane,
}: {
  placeholder: string
  focused: boolean
  onSubmit: (text: string) => void
  onFocusPane?: () => void
}) {
  const editor = useRef<TextareaRenderable | null>(null)
  const box = useRef<BoxRenderable | null>(null)

  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  const history = useRef<string[]>([])
  const histIndex = useRef<number | null>(null)
  const draft = useRef('')

  const matches = useMemo<Command[]>(() => {
    const token = slashToken(text)
    if (token === null) return []
    return COMMANDS.filter((c) => c.name.startsWith(token))
  }, [text])
  const menuOpen = focused && !dismissed && matches.length > 0

  useEffect(() => {
    if (selected >= matches.length) setSelected(0)
  }, [matches.length, selected])

  // OpenTUI layout coords aren't reactive; poll the input box while the popover is open so it stays
  // anchored across resizes.
  useEffect(() => {
    if (!menuOpen) return
    const measure = () => {
      const b = box.current
      if (!b) return
      setAnchor((prev) =>
        prev && prev.x === b.x && prev.y === b.y && prev.width === b.width ? prev : { x: b.x, y: b.y, width: b.width },
      )
    }
    measure()
    const id = setInterval(measure, 50)
    return () => clearInterval(id)
  }, [menuOpen])

  const setBoth = (value: string, cursorToStart = false) => {
    const ed = editor.current
    if (!ed) return
    ed.setText(value)
    ed.cursorOffset = cursorToStart ? 0 : value.length
    setText(value)
  }

  const clear = () => {
    histIndex.current = null
    setDismissed(false)
    setBoth('')
  }

  const submit = () => {
    const value = (editor.current?.plainText ?? '').trim()
    if (!value) return
    if (value !== history.current[history.current.length - 1]) history.current.push(value)
    histIndex.current = null
    onSubmit(value)
    clear()
  }

  const accept = (cmd: Command) => {
    if (cmd.takesArg) {
      setBoth(`/${cmd.name} `)
      return
    }
    onSubmit(`/${cmd.name}`)
    clear()
  }

  const recallPrev = (): boolean => {
    const list = history.current
    if (list.length === 0) return false
    if (histIndex.current === null) {
      draft.current = editor.current?.plainText ?? ''
      histIndex.current = list.length - 1
    } else if (histIndex.current > 0) {
      histIndex.current -= 1
    }
    setBoth(list[histIndex.current], true)
    return true
  }

  const recallNext = (): boolean => {
    if (histIndex.current === null) return false
    const list = history.current
    if (histIndex.current < list.length - 1) {
      histIndex.current += 1
      setBoth(list[histIndex.current])
    } else {
      histIndex.current = null
      setBoth(draft.current)
    }
    return true
  }

  const onKeyDown = (e: KeyEvent) => {
    const ed = editor.current
    if (!ed) return

    if (menuOpen) {
      if (e.name === 'up') {
        e.preventDefault()
        setSelected((s) => (s - 1 + matches.length) % matches.length)
      } else if (e.name === 'down') {
        e.preventDefault()
        setSelected((s) => (s + 1) % matches.length)
      } else if (e.name === 'tab' || (e.name === 'return' && !e.shift)) {
        e.preventDefault()
        const cmd = matches[selected]
        if (cmd) accept(cmd)
      } else if (e.name === 'escape') {
        e.preventDefault()
        setDismissed(true)
      }
      return
    }

    if (e.name === 'return' && !e.shift && !e.meta) {
      e.preventDefault()
      submit()
    } else if (e.name === 'tab' && ed.plainText.length === 0 && onFocusPane) {
      e.preventDefault()
      onFocusPane()
    } else if (e.name === 'up' && ed.cursorOffset === 0) {
      if (recallPrev()) e.preventDefault()
    } else if (e.name === 'down' && ed.cursorOffset === ed.plainText.length) {
      if (recallNext()) e.preventDefault()
    }
  }

  const labelWidth = matches.reduce((w, c) => Math.max(w, c.name.length + (c.arg ? c.arg.length + 1 : 0) + 1), 0)

  return (
    <>
      {menuOpen && anchor ? (
        <box
          position="absolute"
          left={anchor.x}
          top={Math.max(0, anchor.y - matches.length - 2)}
          width={anchor.width}
          zIndex={100}
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={COLORS.border}
          paddingLeft={1}
          paddingRight={1}
        >
          {matches.map((cmd, i) => {
            const isSel = i === selected
            const label = `/${cmd.name}${cmd.arg ? ` ${cmd.arg}` : ''}`.padEnd(labelWidth + 1)
            return (
              <box key={cmd.name} flexDirection="row" backgroundColor={isSel ? COLORS.rowActive : undefined}>
                <text fg={isSel ? COLORS.accent : COLORS.text}>{label}</text>
                <text fg={COLORS.dim}>{cmd.desc}</text>
              </box>
            )
          })}
        </box>
      ) : null}
      <box borderStyle="rounded" border borderColor={focused ? COLORS.accent : COLORS.border} ref={box}>
        <textarea
          ref={editor}
          focused={focused}
          onContentChange={() => {
            const value = editor.current?.plainText ?? ''
            setText(value)
            setDismissed(false)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          placeholderColor={COLORS.dim}
          minHeight={1}
          maxHeight={6}
          textColor={COLORS.text}
          focusedTextColor={COLORS.text}
        />
      </box>
    </>
  )
}
