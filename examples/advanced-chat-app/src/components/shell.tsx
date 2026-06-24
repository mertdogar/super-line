import { useEffect, useMemo, useState } from 'react'
import { ChannelView } from '@/components/channel-view'
import { Sidebar } from '@/components/sidebar'
import type { ChannelsDoc } from '@/contract'
import { useReadState } from '@/hooks/use-read-state'
import { useRequest, useResource, useSubscription } from '@/lib/superline'

export function Shell({ me, onSignOut }: { me: string; onSignOut: () => void }): React.JSX.Element {
  const { data: channelsDoc } = useResource<ChannelsDoc>('chat', 'channels')
  const channels = useMemo(() => channelsDoc?.channels ?? [], [channelsDoc])

  const [activeId, setActiveId] = useState('general')
  const { lastRead, markRead } = useReadState(me)

  // presence: topics aren't retained, so seed the current list once via `hello` (buffered until the
  // socket connects), then stay live via the topic. After an abrupt reconnect the list re-syncs on
  // the next presence change (someone joining/leaving) rather than instantly.
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
  const typingHere = (typing?.byChannel[activeId] ?? []).filter((u) => u !== me)

  // if the active channel disappears, fall back to the first one
  useEffect(() => {
    if (channels.length && !channels.some((c) => c.id === activeId)) setActiveId(channels[0]!.id)
  }, [channels, activeId])

  const active = channels.find((c) => c.id === activeId)

  return (
    <div className="flex h-full">
      <Sidebar
        me={me}
        online={online}
        channels={channels}
        activeId={activeId}
        onSelect={setActiveId}
        lastRead={lastRead}
        onSignOut={onSignOut}
      />
      <ChannelView
        key={activeId}
        me={me}
        channelId={activeId}
        channelName={active?.name ?? activeId}
        typingUsers={typingHere}
        markRead={markRead}
      />
    </div>
  )
}
