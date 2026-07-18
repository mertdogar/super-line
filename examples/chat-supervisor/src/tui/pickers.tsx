// Dialog contents: channel picker (harness thread-picker's armed-inline-action pattern — switch /
// d-armed leave / inline new), session info (flat read-only rows), and the login form driving the
// real plugin-auth flow (sign-in, falling back to register on an unknown account).

import { useMemo, useRef, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import type { TextareaRenderable } from '@opentui/core'
import { SuperLineError } from '@super-line/core'
import { COLORS } from './theme'

interface ChannelLite {
  id: string
  name: string
  visibility?: string
}

type Row = { kind: 'channel'; channel: ChannelLite } | { kind: 'new' }

export function ChannelPicker({
  channels,
  currentId,
  onSwitch,
  onNew,
  onLeave,
  onClose,
}: {
  channels: ChannelLite[]
  currentId: string
  onSwitch: (id: string) => void
  onNew: (name: string) => void
  onLeave: (id: string) => void
  onClose: () => void
}) {
  const rows = useMemo<Row[]>(
    () => [...channels.map((c) => ({ kind: 'channel' as const, channel: c })), { kind: 'new' as const }],
    [channels],
  )
  const [active, setActive] = useState(Math.max(0, channels.findIndex((c) => c.id === currentId)))
  const [armed, setArmed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const move = (delta: number) => {
    setArmed(false)
    setActive((a) => (a + delta + rows.length) % rows.length)
  }

  useKeyboard((key) => {
    if (key.eventType !== 'press' || adding) return
    if (key.name === 'up' || key.name === 'k') move(-1)
    else if (key.name === 'down' || key.name === 'j') move(1)
    else if (key.name === 'return') {
      const row = rows[active]
      if (!row) return
      if (armed && row.kind === 'channel') {
        setArmed(false)
        onLeave(row.channel.id)
        return
      }
      if (row.kind === 'new') {
        setAdding(true)
        setDraft('')
        return
      }
      onSwitch(row.channel.id)
    } else if (key.name === 'd') {
      if (rows[active]?.kind === 'channel') setArmed(true)
    } else if (key.name === 'escape') {
      if (armed) setArmed(false)
      else onClose()
    }
  })

  return (
    <box flexDirection="column">
      {rows.map((row, i) => {
        const isActive = i === active
        const bg = isActive ? COLORS.rowActive : undefined
        if (row.kind === 'new') {
          if (adding) {
            return (
              <box key="new" flexDirection="row" backgroundColor={COLORS.rowActive} gap={1}>
                <text fg={COLORS.green}>＋</text>
                <box flexGrow={1}>
                  <input
                    focused
                    value={draft}
                    onInput={setDraft}
                    onSubmit={() => {
                      const name = draft.trim()
                      setAdding(false)
                      if (name) onNew(name)
                    }}
                    placeholder="channel name — ⏎ create · esc cancel"
                    placeholderColor={COLORS.dim}
                  />
                </box>
              </box>
            )
          }
          return (
            <box key="new" backgroundColor={bg} paddingLeft={2}>
              <text fg={isActive ? COLORS.green : COLORS.dim}>＋ New channel</text>
            </box>
          )
        }
        const c = row.channel
        const isCurrent = c.id === currentId
        if (isActive && armed) {
          return (
            <box key={c.id} flexDirection="row" backgroundColor={bg} gap={1}>
              <text fg={COLORS.red}>✗</text>
              <text fg={COLORS.dim}>{`#${c.name}`}</text>
              <text fg={COLORS.red}>leave? ↵ confirm · esc cancel</text>
            </box>
          )
        }
        return (
          <box key={c.id} flexDirection="row" backgroundColor={bg} gap={1}>
            <text fg={isCurrent ? COLORS.accent : COLORS.dim}>{isCurrent ? '▸' : ' '}</text>
            <text fg={isActive ? COLORS.accent : COLORS.text} flexGrow={1}>
              {`#${c.name}`}
            </text>
            <text fg={COLORS.dim}>{c.visibility ?? ''}</text>
          </box>
        )
      })}
    </box>
  )
}

export function SessionInfo({ rows, onClose }: { rows: { label: string; value: string }[]; onClose: () => void }) {
  useKeyboard((key) => {
    if (key.eventType !== 'press') return
    if (key.name === 'escape' || key.name === 'return') onClose()
  })
  return (
    <box flexDirection="column">
      {rows.map((row) => (
        <box key={row.label} flexDirection="row" gap={1}>
          <text fg={COLORS.dim}>{`${row.label}:`.padEnd(12)}</text>
          <text fg={COLORS.text}>{row.value}</text>
        </box>
      ))}
    </box>
  )
}

export function Login({
  onSignIn,
  onSignUp,
}: {
  onSignIn: (input: { email: string; password: string }) => Promise<void>
  onSignUp: (input: { email: string; password: string; displayName: string }) => Promise<void>
}) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [field, setField] = useState<'email' | 'password' | 'displayName'>('email')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const fields: typeof field[] = mode === 'signup' ? ['email', 'password', 'displayName'] : ['email', 'password']
  const cycle = (dir: 1 | -1) => setField((f) => fields[(fields.indexOf(f) + dir + fields.length) % fields.length]!)

  useKeyboard((key) => {
    if (key.eventType !== 'press' || busy) return
    if (key.name === 'tab') cycle(key.shift ? -1 : 1)
  })

  const submit = () => {
    if (busy) return
    const idx = fields.indexOf(field)
    if (idx < fields.length - 1) {
      setField(fields[idx + 1]!)
      return
    }
    const em = email.trim()
    if (!em || !password) return
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        if (mode === 'signup') {
          const name = displayName.trim()
          if (!name) {
            setBusy(false)
            setField('displayName')
            setError('pick a display name')
            return
          }
          await onSignUp({ email: em, password, displayName: name })
        } else {
          await onSignIn({ email: em, password })
        }
      } catch (err) {
        setBusy(false)
        if (mode === 'signin') {
          // unknown account / bad credentials → offer to create one
          setMode('signup')
          setField('displayName')
          setError('no account here yet — add a display name to create one')
          return
        }
        setError(err instanceof SuperLineError ? err.message : 'something went wrong')
      }
    })()
  }

  const dot = (v: string) => '•'.repeat(v.length)
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.dim}>{'email:'.padEnd(12)}</text>
        <box flexGrow={1}>
          <input
            focused={field === 'email'}
            value={email}
            onInput={setEmail}
            onSubmit={submit}
            placeholder="you@example.dev"
            placeholderColor={COLORS.dim}
          />
        </box>
      </box>
      <box flexDirection="row" gap={1}>
        <text fg={COLORS.dim}>{'password:'.padEnd(12)}</text>
        <box flexGrow={1}>
          <input
            focused={field === 'password'}
            value={dot(password)}
            onInput={(v: string) => setPassword(v)}
            onSubmit={submit}
            placeholder="········"
            placeholderColor={COLORS.dim}
          />
        </box>
      </box>
      {mode === 'signup' ? (
        <box flexDirection="row" gap={1}>
          <text fg={COLORS.dim}>{'name:'.padEnd(12)}</text>
          <box flexGrow={1}>
            <input
              focused={field === 'displayName'}
              value={displayName}
              onInput={setDisplayName}
              onSubmit={submit}
              placeholder="e.g. Ada"
              placeholderColor={COLORS.dim}
            />
          </box>
        </box>
      ) : null}
      {error ? <text fg={COLORS.red}>{error}</text> : null}
      <text fg={COLORS.dim}>
        {busy ? 'signing in…' : `⏎ next/submit · ⇥ switch field · ${mode === 'signup' ? 'creating account' : 'session is cached'}`}
      </text>
    </box>
  )
}

const EDITOR_KEYS = [
  { name: 'return', action: 'submit' as const },
  { name: 'return', shift: true, action: 'newline' as const },
]

/** The note/block text editor (ask-user's inline-editor keyBindings trick): ⏎ saves, shift+⏎ newlines. */
export function TextEditor({
  initial,
  onSave,
  onClose,
}: {
  initial: string
  onSave: (text: string) => void
  onClose: () => void
}) {
  const editor = useRef<TextareaRenderable | null>(null)
  useKeyboard((key) => {
    if (key.eventType !== 'press') return
    if (key.name === 'escape') onClose()
  })
  return (
    <box flexDirection="column">
      <box border borderStyle="rounded" borderColor={COLORS.accent}>
        <textarea
          ref={editor}
          focused
          initialValue={initial}
          minHeight={1}
          maxHeight={8}
          textColor={COLORS.text}
          focusedTextColor={COLORS.text}
          keyBindings={EDITOR_KEYS}
          onSubmit={() => onSave(editor.current?.plainText ?? '')}
        />
      </box>
      <text fg={COLORS.dim}>⏎ save · shift+⏎ newline · esc cancel</text>
    </box>
  )
}
