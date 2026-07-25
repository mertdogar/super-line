import type * as React from 'react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** `n` with a naively pluralized unit: `plural(1, 'node') → '1 node'`, `plural(3, 'node') → '3 nodes'`. */
export function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** Props that make a clickable non-button element (a table row) reachable and activatable by keyboard. */
export function clickable(onActivate: () => void): {
  role: 'button'
  tabIndex: number
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onActivate()
    },
  }
}
