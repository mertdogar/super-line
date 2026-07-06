import { useState, type FormEvent } from 'react'
import { MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function JoinScreen({ onJoin }: { onJoin: (name: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed) onJoin(trimmed)
  }

  return (
    <div className="flex h-full items-center justify-center bg-sidebar p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl bg-background p-8 shadow-2xl"
      >
        <div className="flex items-center gap-2 text-primary">
          <MessageSquare className="h-7 w-7" />
          <span className="text-2xl font-bold tracking-tight text-foreground">super-line</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Pick a display name to join the workspace. Channels, membership &amp; history are typed
          collections synced by super-line, with row-level security enforced server-side.
        </p>
        <label className="mt-6 block text-sm font-medium" htmlFor="name">
          Display name
        </label>
        <Input
          id="name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. ada"
          className="mt-1.5 h-11"
        />
        <Button type="submit" className="mt-4 h-11 w-full" disabled={!name.trim()}>
          Open chat
        </Button>
      </form>
    </div>
  )
}
