import * as React from 'react'

/**
 * The shared detail panel: a right-docked, NON-modal inspector — no backdrop, no focus trap — so the
 * table/graph behind it stays live and clicking another row re-targets the open panel (comparative
 * inspection with no close-click between each). Esc closes it; the children own their close buttons.
 * ConnDetail and NodeDetail render their header + body as children.
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
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <section
      aria-label={label}
      className="absolute inset-y-0 right-0 z-10 w-104 overflow-auto border-l bg-card p-4"
    >
      {children}
    </section>
  )
}
