// Verbatim port of super-harness/packages/tui/src/dialog.tsx (modal shell).

import type { ReactNode } from 'react'
import { useTerminalDimensions } from '@opentui/react'
import { RGBA } from '@opentui/core'
import { COLORS } from './theme'

export function Dialog({
  title,
  footer,
  children,
}: {
  title: string
  footer?: string
  children: ReactNode
}) {
  const { width, height } = useTerminalDimensions()
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      zIndex={1000}
      justifyContent="center"
      alignItems="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        flexDirection="column"
        width={Math.min(72, width - 4)}
        maxWidth={width - 2}
        maxHeight={height - 2}
        backgroundColor={COLORS.panel}
        border
        borderStyle="rounded"
        borderColor={COLORS.accent}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={COLORS.accent}>{title}</text>
          <text fg={COLORS.dim}>esc</text>
        </box>
        {children}
        {footer ? <text fg={COLORS.dim}>{footer}</text> : null}
      </box>
    </box>
  )
}
