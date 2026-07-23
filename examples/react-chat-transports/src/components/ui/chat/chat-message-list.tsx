// Adapted from shadcn-chat (jakobhoeg/shadcn-chat, MIT) — React 19 plain-function form, cn()-merged
// className, and no built-in horizontal padding (the Slack rows own their own padding).
import * as React from 'react'
import { ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAutoScroll } from './hooks/useAutoScroll'

interface ChatMessageListProps extends React.HTMLAttributes<HTMLDivElement> {
  smooth?: boolean
}

export function ChatMessageList({
  className,
  children,
  smooth = false,
  ...props
}: ChatMessageListProps): React.JSX.Element {
  const { scrollRef, isAtBottom, scrollToBottom, disableAutoScroll } = useAutoScroll({
    smooth,
    content: children,
  })

  return (
    <div className="relative h-full w-full">
      <div
        className={cn('flex h-full w-full flex-col overflow-y-auto py-4', className)}
        ref={scrollRef}
        onWheel={disableAutoScroll}
        onTouchMove={disableAutoScroll}
        {...props}
      >
        <div className="flex flex-col">{children}</div>
      </div>

      {!isAtBottom && (
        <Button
          onClick={scrollToBottom}
          size="icon"
          variant="outline"
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 rounded-full shadow-md"
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
