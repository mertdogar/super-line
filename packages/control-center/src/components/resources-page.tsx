import * as React from 'react'
import { BookOpen, ExternalLink, Github, Package, Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const RESOURCES = [
  {
    icon: Sparkles,
    title: 'super-line',
    href: 'https://mertdogar.github.io/super-line/',
    blurb: 'The home page — what super-line is and why typesafe WebSockets.',
  },
  {
    icon: BookOpen,
    title: 'Documentation',
    href: 'https://mertdogar.github.io/super-line/guide/getting-started',
    blurb: 'Guides, the full API reference, and runnable examples.',
  },
  {
    icon: Github,
    title: 'GitHub',
    href: 'https://github.com/mertdogar/super-line',
    blurb: 'Browse the source, report issues, and contribute.',
  },
  {
    icon: Package,
    title: 'npm',
    href: 'https://www.npmjs.com/package/@super-line/core',
    blurb: 'The @super-line/* packages — core, server, client, react, adapters.',
  },
]

export function ResourcesPage(): React.JSX.Element {
  return (
    <div className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
      {RESOURCES.map((r) => (
        <a key={r.title} href={r.href} target="_blank" rel="noreferrer" className="group block">
          <Card className="h-full transition-colors hover:border-primary/60 hover:bg-accent/30">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <r.icon className="h-4 w-4 text-primary" />
                {r.title}
                <ExternalLink className="ml-auto h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{r.blurb}</CardContent>
          </Card>
        </a>
      ))}
    </div>
  )
}
