import { useState, type FormEvent } from 'react'
import { Hash, Lock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useChat } from '@/lib/chat'
import { cn } from '@/lib/utils'

export function CreateChannelDialog({ onCreated }: { onCreated: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chat = useChat()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      // server-authoritative createChannel request: the caller becomes owner + first member atomically
      const channel = await chat.createChannel({ name: trimmed, visibility })
      setOpen(false)
      setName('')
      setVisibility('public')
      setError(null)
      onCreated(channel.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create channel')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        className="grid h-5 w-5 place-items-center rounded text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
        aria-label="Create channel"
        title="Create channel"
      >
        <Plus className="h-4 w-4" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a channel</DialogTitle>
          <DialogDescription>You’ll be its owner — invite members and manage who can post.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex h-9 items-center gap-2 rounded-md border border-input px-3 focus-within:ring-2 focus-within:ring-ring">
            <Hash className="h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              placeholder="e.g. marketing"
              className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <VisibilityOption
              icon={<Hash className="h-4 w-4" />}
              label="Public"
              hint="Anyone can find and join"
              selected={visibility === 'public'}
              onSelect={() => setVisibility('public')}
            />
            <VisibilityOption
              icon={<Lock className="h-4 w-4" />}
              label="Private"
              hint="Members are invited by an owner"
              selected={visibility === 'private'}
              onSelect={() => setVisibility('private')}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create channel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function VisibilityOption({
  icon,
  label,
  hint,
  selected,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  hint: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-1 rounded-md border p-3 text-left transition',
        selected ? 'border-primary ring-1 ring-primary' : 'border-input hover:border-muted-foreground/50',
      )}
    >
      <span className="flex items-center gap-2 font-medium">
        {icon}
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}
