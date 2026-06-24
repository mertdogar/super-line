import { useState, type FormEvent } from 'react'
import { Hash, Plus } from 'lucide-react'
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
import { useRequest } from '@/lib/superline'

export function CreateChannelDialog({
  onCreated,
}: {
  onCreated: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { call: createChannel, isLoading } = useRequest('createChannel')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const { id } = await createChannel({ name: trimmed })
      setOpen(false)
      setName('')
      setError(null)
      onCreated(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create channel')
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
          <DialogDescription>
            Channels are where conversations happen. The name is lowercased and hyphenated.
          </DialogDescription>
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isLoading || !name.trim()}>
              {isLoading ? 'Creating…' : 'Create channel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
