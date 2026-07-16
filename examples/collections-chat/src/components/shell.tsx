import { useEffect, useMemo, useState } from 'react'
import { ChannelView } from '@/components/channel-view'
import { Sidebar } from '@/components/sidebar'
import { useChannels, useMe, useMyMemberships } from '@/lib/chat'
import { useRequest, useSubscription } from '@/lib/superline'

export function Shell({ myName, onSignOut }: { myName: string; onSignOut: () => void }): React.JSX.Element {
  const me = useMe()
  // Every channel I can see: public ones + private ones I belong to (the plugin's read policy).
  const channels = useChannels()
  const myMemberships = useMyMemberships()
  const joinedIds = useMemo(() => myMemberships.map((m) => m.channelId), [myMemberships])

  const [activeId, setActiveId] = useState<string | null>(null)
  // default to the first channel once the directory arrives
  const active = channels.find((c) => c.id === activeId) ?? channels[0]
  useEffect(() => {
    if (!activeId && active) setActiveId(active.id)
  }, [activeId, active])

  // presence: seed once via `hello` (topics aren't retained), then stay live via the topic
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
  const typingHere = active ? (typing?.byChannel[active.id] ?? []).filter((u) => u !== myName) : []
  const isMember = active ? joinedIds.includes(active.id) : false

  return (
    <div className="flex h-full">
      <Sidebar
        myName={myName}
        online={online}
        channels={channels}
        joined={joinedIds}
        activeId={active?.id ?? ''}
        onSelect={setActiveId}
        onSignOut={onSignOut}
      />
      {active ? (
        <ChannelView
          key={active.id}
          myUserId={me}
          channel={active}
          isMember={isMember}
          typingUsers={typingHere}
        />
      ) : (
        <div className="grid flex-1 place-items-center bg-background text-sm text-muted-foreground">
          No channels yet.
        </div>
      )}
    </div>
  )
}
