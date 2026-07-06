import { useEffect, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { ChannelView } from '@/components/channel-view'
import { Sidebar } from '@/components/sidebar'
import { useChat } from '@/lib/chat'
import { useReadState } from '@/hooks/use-read-state'
import { useRequest, useSubscription } from '@/lib/superline'

export function Shell({ myName, onSignOut }: { myName: string; onSignOut: () => void }): React.JSX.Element {
  const { me, channels: channelsCol, myChannelIds } = useChat()

  // The full public channel directory (every channel is world-readable so you can discover + join it).
  const { data: channels } = useLiveQuery((q) => q.from({ c: channelsCol }).orderBy(({ c }) => c.createdAt, 'asc'))

  const [activeId, setActiveId] = useState('general')
  const { lastRead, markRead } = useReadState(me)

  // presence: topics aren't retained, so seed the current list once via `hello` (buffered until the
  // socket connects), then stay live via the topic.
  const { call: hello } = useRequest('hello')
  const [online, setOnline] = useState<string[]>([])
  useEffect(() => {
    hello()
      .then((r) => setOnline(r.users))
      .catch(() => {})
  }, [hello])
  const presence = useSubscription('presence')
  useEffect(() => {
    if (presence) setOnline(presence.users)
  }, [presence])

  const typing = useSubscription('typing')
  const typingHere = (typing?.byChannel[activeId] ?? []).filter((u) => u !== myName)

  const active = channels.find((c) => c.id === activeId)
  const isMember = myChannelIds.includes(activeId)

  return (
    <div className="flex h-full">
      <Sidebar
        myName={myName}
        online={online}
        channels={channels}
        joined={myChannelIds}
        activeId={activeId}
        onSelect={setActiveId}
        lastRead={lastRead}
        onSignOut={onSignOut}
      />
      <ChannelView
        key={activeId}
        myUserId={me}
        channelId={activeId}
        channelName={active?.name ?? activeId}
        isMember={isMember}
        typingUsers={typingHere}
        markRead={markRead}
      />
    </div>
  )
}
