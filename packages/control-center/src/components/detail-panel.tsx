import * as React from 'react'

function focusableEls(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => el.offsetParent !== null)
}

/**
 * The shared slide-in detail overlay: a dimmed backdrop + a right-docked panel, with real dialog
 * semantics — role="dialog"/aria-modal, Esc to close, a Tab focus-trap, and focus returned to whatever
 * opened it. ConnDetail and NodeDetail render their header + body as children.
 */
export function DetailPanel({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const panelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const els = focusableEls(panelRef.current)
      if (els.length === 0) {
        e.preventDefault()
        return
      }
      const first = els[0]!
      const last = els[els.length - 1]!
      const active = document.activeElement as HTMLElement
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [onClose])

  return (
    <div className="absolute inset-0 z-10 flex">
      <button type="button" tabIndex={-1} className="flex-1 bg-black/40" onClick={onClose} aria-label="Close detail" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="w-104 overflow-auto border-l bg-card p-4 outline-none"
      >
        {children}
      </div>
    </div>
  )
}
