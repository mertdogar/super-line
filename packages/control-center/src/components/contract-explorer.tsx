import * as React from 'react'
import type {
  InspectedContract,
  InspectedDirectional,
  InspectedMessage,
  MessageFlavor,
} from '@super-line/core'
import { flavorColor } from '@/lib/events'
import { Json } from '@/components/json-view'

function FlavorBadge({ flavor }: { flavor: MessageFlavor }): React.JSX.Element {
  const color = flavorColor(flavor)
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ background: `${color}22`, color, border: `1px solid ${color}66` }}
    >
      {flavor}
    </span>
  )
}

function Message({ message }: { message: InspectedMessage }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const schemas = (
    [
      ['input', message.input],
      ['output', message.output],
      ['payload', message.payload],
    ] as Array<[string, unknown]>
  ).filter(([, schema]) => schema !== undefined)
  const hasSchema = schemas.length > 0

  return (
    <div className="rounded-md border">
      <button
        onClick={() => hasSchema && setOpen((o) => !o)}
        disabled={!hasSchema}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <FlavorBadge flavor={message.flavor} />
        <span className="font-mono text-sm">{message.name}</span>
        {hasSchema ? <span className="ml-auto text-xs text-muted-foreground">{open ? '−' : '+'}</span> : null}
      </button>
      {open ? (
        <div className="space-y-2 border-t p-3">
          {schemas.map(([label, schema]) => (
            <div key={label}>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
              <Json data={schema} className="max-h-72" />
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">
            schema · best-effort (refinements / transforms may be dropped)
          </p>
        </div>
      ) : null}
    </div>
  )
}

function Direction({ label, messages }: { label: string; messages: InspectedMessage[] }): React.JSX.Element | null {
  if (messages.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex flex-col gap-1.5">
        {messages.map((m) => (
          <Message key={m.name} message={m} />
        ))}
      </div>
    </div>
  )
}

function Block({ title, dir }: { title: string; dir: InspectedDirectional }): React.JSX.Element | null {
  if (dir.clientToServer.length === 0 && dir.serverToClient.length === 0) return null
  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <div className="flex flex-col gap-3">
        <Direction label="client → server" messages={dir.clientToServer} />
        <Direction label="server → client" messages={dir.serverToClient} />
      </div>
    </div>
  )
}

export function ContractExplorer({ contract }: { contract: InspectedContract }): React.JSX.Element {
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <Block title="shared" dir={contract.shared} />
      {Object.entries(contract.roles).map(([role, dir]) => (
        <Block key={role} title={`role · ${role}`} dir={dir} />
      ))}
      {contract.serverToServer.length > 0 ? (
        <div className="rounded-lg border bg-card/40 p-3">
          <div className="mb-2 text-sm font-semibold">serverToServer</div>
          <div className="flex flex-col gap-1.5">
            {contract.serverToServer.map((m) => (
              <Message key={m.name} message={m} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
