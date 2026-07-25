import * as React from 'react'
import { BookOpen, ExternalLink, Github, Package, Sparkles } from 'lucide-react'

const RESOURCES = [
  {
    icon: Sparkles,
    title: 'super-line',
    href: 'https://mertdogar.github.io/super-line/',
    blurb: 'The home page — what super-line is and why a strictly-typed realtime data bus.',
  },
  {
    icon: BookOpen,
    title: 'Documentation',
    href: 'https://mertdogar.github.io/super-line/tutorials/',
    blurb: 'Tutorials, how-to guides, the full API reference, and runnable examples.',
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
    <div className="flex max-w-2xl flex-col divide-y rounded-md border">
      {RESOURCES.map((r) => (
        <a
          key={r.title}
          href={r.href}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <r.icon className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="text-sm font-medium">{r.title}</div>
            <div className="truncate text-xs text-muted-foreground">{r.blurb}</div>
          </div>
          <ExternalLink className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </a>
      ))}
    </div>
  )
}
