import type * as React from 'react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/** Props that make a clickable non-button element (a table row) reachable and activatable by keyboard. */
export function clickable(onActivate: () => void): {
  tabIndex: number
  onClick: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  return {
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onActivate()
    },
  }
}
