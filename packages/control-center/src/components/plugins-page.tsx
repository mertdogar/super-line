import * as React from 'react'
import type { InspectedContract, InspectedPlugin } from '@super-line/core'
import { contributionCounts } from '@/lib/plugins'

function Half({ ok, label, hint }: { ok: boolean; label: string; hint: string }): React.JSX.Element {
  return (
    <span
      title={hint}
      className={
        ok
          ? 'inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary'
          : 'inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground line-through'
      }
    >
      {label}
    </span>
  )
}

function KeyList({ title, names }: { title: string; names: string[] }): React.JSX.Element | null {
  if (names.length === 0) return null
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1">
        {names.map((n) => (
          <span key={n} className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">
            {n}
          </span>
        ))}
      </div>
    </div>
  )
}

function PluginCard({ plugin }: { plugin: InspectedPlugin }): React.JSX.Element {
  const { collections, messages } = contributionCounts(plugin)
  const c = plugin.contract
  // a fragment merged with no server half registered: the calls type-check, then fail with NOT_FOUND
  const unregistered = !plugin.runtime
  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">{plugin.name}</span>
        <Half ok={plugin.runtime} label="runtime" hint="a server plugin of this name is registered" />
        <Half ok={!!c} label="contract" hint="this plugin merged a contract fragment" />
        <span className="ml-auto text-xs text-muted-foreground">
          {c ? `${collections} collections · ${messages} messages` : 'no contract surface'}
        </span>
      </div>
      {unregistered ? (
        <p className="mt-2 text-xs text-destructive">
          Contract fragment merged, but no server plugin named <span className="font-mono">{plugin.name}</span> is
          registered — its requests will fail with <span className="font-mono">NOT_FOUND</span>.
        </p>
      ) : null}
      {c ? (
        <div className="mt-3 flex flex-col gap-2.5">
          <KeyList title="collections" names={c.collections} />
          <KeyList title="shared · client → server" names={c.shared?.clientToServer ?? []} />
          <KeyList title="shared · server → client" names={c.shared?.serverToClient ?? []} />
          {Object.entries(c.roles ?? {}).map(([role, block]) => (
            <React.Fragment key={role}>
              <KeyList title={`role ${role} · client → server`} names={block.clientToServer} />
              <KeyList title={`role ${role} · server → client`} names={block.serverToClient} />
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * What this server is composed of (ADR-0016): every plugin, with its two independent halves — the runtime
 * registration and the contract fragment. A plugin present in one half only is the interesting case.
 */
export function PluginsPage({ contract }: { contract: InspectedContract | null }): React.JSX.Element {
  const plugins = contract?.plugins
  if (!plugins) {
    return (
      <p className="text-sm text-muted-foreground">
        This node doesn&apos;t report plugins — it predates plugin provenance on <span className="font-mono">getContract</span>.
      </p>
    )
  }
  if (plugins.length === 0) return <p className="text-sm text-muted-foreground">No plugins registered.</p>
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      {plugins.map((p) => (
        <PluginCard key={p.name} plugin={p} />
      ))}
    </div>
  )
}
