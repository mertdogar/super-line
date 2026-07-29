import { useEffect, useMemo, useState } from 'react'
import { ChannelView } from '@/components/channel-view'
import { DocumentPane } from '@/components/document-pane'
import { Sidebar } from '@/components/sidebar'
import { useChannels, useMe, useMyMemberships } from '@/lib/chat'
import { cn } from '@/lib/utils'

export function Shell({ onSignOut }: { onSignOut: () => void }): React.JSX.Element {
  const me = useMe()
  // Every channel I can see: public ones + private ones I belong to (the plugin's read policy).
  const channels = useChannels()
  const myMemberships = useMyMemberships()
  const joinedIds = useMemo(() => myMemberships.map((m) => m.channelId), [myMemberships])

  const [activeId, setActiveId] = useState<string | null>(null)
  // mobile: the sidebar is an off-canvas drawer (hamburger in the channel header opens it)
  const [navOpen, setNavOpen] = useState(false)
  // Open by default only where both columns fit. Narrower than that the document would take the whole
  // column, and landing a chat app on its notepad is the wrong first impression — so there it waits behind
  // the header's Doc button instead. (`lg`, matching the breakpoint the layout below switches on.)
  const [docOpen, setDocOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024)
  // default to the first channel once the directory arrives
  const active = channels.find((c) => c.id === activeId) ?? channels[0]
  useEffect(() => {
    if (!activeId && active) setActiveId(active.id)
  }, [activeId, active])

  const isMember = active ? joinedIds.includes(active.id) : false

  return (
    <div className="flex h-full">
      {navOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" aria-hidden onClick={() => setNavOpen(false)} />}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-40 transition-transform md:static md:z-auto md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        <Sidebar
          channels={channels}
          joined={joinedIds}
          activeId={active?.id ?? ''}
          onSelect={(id) => {
            setActiveId(id)
            setNavOpen(false)
          }}
          onSignOut={onSignOut}
        />
      </div>
      {active ? (
        // The conversation and the channel's document, side by side: two consistency models on one
        // connection. Messages are rows — validated, queryable, last-writer-wins. The document is a CRDT
        // whose text merges per character. Both are `collection(…)`, and neither knows about the other.
        //
        // Side by side needs room, and a developer running this with DevTools docked has less of it than
        // it looks. So the pane is toggled rather than dropped below a breakpoint — wide enough and both
        // columns show; otherwise the document takes the column while it is open. A pane that silently
        // disappears at some window width is indistinguishable from one that is broken.
        <>
          <div className={cn('flex min-w-0 flex-1', docOpen && 'hidden lg:flex')}>
            <ChannelView
              key={active.id}
              myUserId={me}
              channel={active}
              isMember={isMember}
              onOpenNav={() => setNavOpen(true)}
              docOpen={docOpen}
              onToggleDoc={() => setDocOpen((d) => !d)}
            />
          </div>
          {docOpen && (
            <DocumentPane
              key={`doc-${active.id}`}
              channel={active}
              isMember={isMember}
              onClose={() => setDocOpen(false)}
            />
          )}
        </>
      ) : (
        <div className="grid flex-1 place-items-center bg-background text-sm text-muted-foreground">No channels yet.</div>
      )}
    </div>
  )
}
