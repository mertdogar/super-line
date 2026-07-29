import { useEffect, useMemo, type ReactNode } from 'react'
import { FileText, X } from 'lucide-react'
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { yDocOf } from '@super-line/collections-crdt-memory'
import { useClient, useDoc } from '@super-line/plugin-auth/react'
import { NOTE_FIELD, NOTE_KIND, type Channel, type CrdtName } from '@/contract'
import { EditorToolbar } from '@/components/editor-toolbar'
import { bridgeAwareness } from '@/lib/awareness'
import { useChannelResources, useMe, useUsers } from '@/lib/chat'

// A stable per-user colour, used for the caret, its name label, the tint over their selection, and their
// avatar — one identity, one colour, everywhere. Any hash will do; it only has to agree with itself across
// tabs so the same person keeps the same colour wherever they are.
const COLORS = ['#e11d48', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#4f46e5', '#9333ea', '#db2777']
function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]!
}

interface Peer {
  name: string
  color: string
}

/**
 * The channel's shared document, beside its conversation.
 *
 * The interesting line is the one that isn't here: there is no provider. Tiptap wants a `Y.Doc` and does
 * not care how it syncs, and super-line is already syncing this one — so `yDocOf` hands over the document
 * behind the open handle and the wiring is finished. Its `field` is a Yjs root name, which is exactly what
 * a **native root** is: a CRDT type sitting beside the contract-described root, holding text that merges
 * per character instead of per field.
 */
export function DocumentPane({
  channel,
  isMember,
  onClose,
}: {
  channel: Channel
  isMember: boolean
  onClose?: () => void
}): React.JSX.Element {
  // The registry row is the document's other half: an ordinary validated, queryable, membership-gated row,
  // and the reason the pane can show a title at all — a CRDT collection is opened by id and never queried,
  // so a document's own name could not live inside it.
  const resources = useChannelResources(isMember ? channel.id : null)
  const resource = resources.find((r) => r.kind === NOTE_KIND)
  const title = resource?.title ?? `${channel.name} notes`
  // Takes the whole column when it is the only one, and a side panel once there is room for both.
  const shell = 'flex min-w-0 flex-1 flex-col bg-background lg:min-w-[22rem] lg:max-w-[38%] lg:border-l'

  return (
    <aside className={shell}>
      {!isMember ? (
        <>
          <Header title={title} onClose={onClose} />
          <Empty>Join this channel to open its document.</Empty>
        </>
      ) : !resource ? (
        <>
          <Header title={title} onClose={onClose} />
          <Empty>Loading…</Empty>
        </>
      ) : (
        // `collection` is denormalized onto the registry row so a row self-describes which CRDT
        // collection to open — nothing here has to know the kind's collection name.
        <Editor
          key={resource.docId}
          channelId={channel.id}
          collection={resource.collection}
          docId={resource.docId}
          title={title}
          onClose={onClose}
        />
      )}
    </aside>
  )
}

function Header({ title, children, onClose }: { title: string; children?: ReactNode; onClose?: () => void }): React.JSX.Element {
  return (
    <header className="flex items-center gap-2 border-b px-4 py-2.5 shadow-sm">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
      {children}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close document"
          className="-mr-1 grid size-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </header>
  )
}

function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">{children}</div>
}

function Editor({
  channelId,
  collection,
  docId,
  title,
  onClose,
}: {
  channelId: string
  collection: string
  docId: string
  title: string
  onClose?: () => void
}): React.JSX.Element {
  const client = useClient()!
  const me = useMe()
  const users = useUsers()

  // The pairing plugin-chat documents: `useChannelResources` for the registry row, `useDoc` for its
  // document. The hook owns the whole lifecycle — open on mount, close on unmount, re-open when the id
  // changes — so there is nothing to hand-roll here. The cast is the one seam: a registry row's
  // `collection` is a plain string, while `useDoc` wants a collection name the contract declares.
  const { native } = useDoc(collection as CrdtName, docId)

  const identity = useMemo(() => ({ name: users.get(me)?.displayName ?? 'someone', color: colorFor(me) }), [users, me])

  const bridge = useMemo(() => {
    if (!native) return undefined
    return bridgeAwareness(client, channelId, yDocOf({ native: () => native }), identity)
  }, [native, client, channelId, identity])
  useEffect(() => () => bridge?.destroy(), [bridge])

  // The editor lives in a child that only mounts once there is a document to bind to. Building it here
  // instead would mean calling `useEditor` on the first render with no extensions, and ProseMirror
  // rejects an extension-less schema outright ("Schema is missing its top node type").
  //
  // `native` appears as soon as the handle exists, which is NOT the same as the catch-up snapshot having
  // landed. Opening a document that already has content can therefore bind an editor to an empty
  // fragment, and y-prosemirror will insert the paragraph ProseMirror requires — a real op that merges
  // with the arriving content and leaves a stray empty paragraph. Closing that properly wants a
  // readiness signal from `useDoc`, which it does not yet expose.
  if (!bridge) {
    return (
      <>
        <Header title={title} onClose={onClose} />
        <Empty>Opening…</Empty>
      </>
    )
  }
  return <Surface ydoc={yDocOf({ native: () => native })} awareness={bridge.awareness} identity={identity} title={title} onClose={onClose} />
}

function Surface({
  ydoc,
  awareness,
  identity,
  title,
  onClose,
}: {
  ydoc: ReturnType<typeof yDocOf>
  awareness: ReturnType<typeof bridgeAwareness>['awareness']
  identity: Peer
  title: string
  onClose?: () => void
}): React.JSX.Element {
  const editor = useEditor({
    extensions: [
      // Collaboration ships its own history — a shared undo stack must not undo other people's edits,
      // which is precisely what the stock one would do.
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: 'Start typing — everyone in this channel sees it as you go…' }),
      Collaboration.configure({ document: ydoc, field: NOTE_FIELD }),
      CollaborationCaret.configure({
        provider: { awareness },
        user: identity,
        // The default builder hard-codes `background-color: <color>70`, which is both heavy-handed and
        // impossible to restyle. Emitting the documented class and passing the writer's colour through
        // `color` instead hands the tint to CSS, where `currentColor` lets one rule serve every user.
        selectionRender: (user: { color?: string }) => ({
          class: 'collaboration-carets__selection',
          style: `color: ${user.color ?? '#71717a'}`,
        }),
      }),
    ],
    editorProps: { attributes: { class: 'min-h-full' } },
    // If a peer's document contains a node this build's schema does not know, stop collaborating rather
    // than let the mismatch write itself into the shared document. Tiptap's own recommendation for a
    // collaborative editor, and cheap insurance whenever two tabs can be running different code.
    enableContentCheck: true,
    onContentError: ({ disableCollaboration }) => disableCollaboration(),
    immediatelyRender: false,
  })

  return (
    <>
      <Header title={title} onClose={onClose}>
        <PresenceStack editor={editor} />
      </Header>
      {editor && <EditorToolbar editor={editor} />}
      <div className="min-h-0 flex-1 cursor-text overflow-y-auto px-5 py-4 text-[0.9375rem]" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} className="h-full" />
      </div>
    </>
  )
}

/**
 * Who is in the document. CollaborationCaret already maintains this from awareness — the same feed that
 * draws the carets — so the roster costs no traffic of its own, and reading its storage rather than the
 * awareness states directly keeps one source of truth for who is present.
 */
function PresenceStack({ editor }: { editor: TiptapEditor | null }): React.JSX.Element | null {
  const users = useEditorState({
    editor,
    selector: (ctx) => (ctx.editor?.storage.collaborationCaret?.users ?? []) as Array<Partial<Peer>>,
    equalityFn: (a, b) => a.length === (b?.length ?? -1) && a.every((u, i) => u.name === b?.[i]?.name),
  })

  // One chip per person, not per connection: the same user in two tabs is two carets but one human,
  // and a roster showing "A A" reads as a bug.
  const byName = new Map<string, Peer>()
  for (const u of users ?? []) if (u.name) byName.set(u.name, { name: u.name, color: u.color ?? '#71717a' })
  const peers = [...byName.values()]
  if (peers.length === 0) return null
  const shown = peers.slice(0, 4)
  const rest = peers.length - shown.length
  return (
    <div className="flex shrink-0 items-center -space-x-1.5" aria-label={`${peers.length} viewing`}>
      {shown.map((p) => (
        <span
          key={p.name}
          title={p.name}
          style={{ backgroundColor: p.color }}
          className="grid size-6 place-items-center rounded-full text-[10px] font-bold text-white ring-2 ring-background"
        >
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {rest > 0 && (
        <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground ring-2 ring-background">
          +{rest}
        </span>
      )}
    </div>
  )
}
