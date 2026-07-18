// Verbatim port of super-harness/packages/tui/src/spinner.tsx (KITT scanner).

import { useEffect, useState } from 'react'
import { COLORS } from './theme'

const WIDTH = 7
const CYCLE = WIDTH * 2 - 2
const CHARS = ['┈', '░', '▒', '▓', '█']
const FALLOFF = 0.28

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`
}

function cells(frame: number): { char: string; color: string }[] {
  const forward = frame < WIDTH
  const head = forward ? frame : CYCLE - frame
  return Array.from({ length: WIDTH }, (_, i) => {
    const behind = forward ? head - i : i - head
    const intensity = behind >= 0 ? Math.max(0, 1 - behind * FALLOFF) : 0
    return {
      char: CHARS[Math.round(intensity * (CHARS.length - 1))],
      color: intensity <= 0 ? COLORS.border : mix(COLORS.border, COLORS.accent, intensity),
    }
  })
}

export function GradientSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % CYCLE), 90)
    return () => clearInterval(id)
  }, [])
  return (
    <box flexDirection="row">
      {cells(frame).map((cell, i) => (
        <text key={i} fg={cell.color}>
          {cell.char}
        </text>
      ))}
    </box>
  )
}
