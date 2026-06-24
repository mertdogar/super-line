import { useState } from 'react'
import { JoinScreen } from '@/components/join-screen'
import { Workspace } from '@/components/workspace'

const NAME_KEY = 'slack:name'

// initial identity: ?name=ada in the URL (handy for opening two windows side by side) or the last
// name saved to localStorage
function initialName(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('name')?.trim()
  return fromUrl || localStorage.getItem(NAME_KEY)
}

export function App(): React.JSX.Element {
  const [name, setName] = useState<string | null>(initialName)

  const signIn = (n: string) => {
    localStorage.setItem(NAME_KEY, n)
    setName(n)
  }
  const signOut = () => {
    localStorage.removeItem(NAME_KEY)
    setName(null)
  }

  return name ? <Workspace name={name} onSignOut={signOut} /> : <JoinScreen onJoin={signIn} />
}
