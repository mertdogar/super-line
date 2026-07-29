import { useState, type ReactNode } from 'react'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Minus,
  Redo2,
  SquareCode,
  Strikethrough,
  TextQuote,
  Underline,
  Undo2,
} from 'lucide-react'
import { useEditorState, type Editor } from '@tiptap/react'
import { cn } from '@/lib/utils'

/**
 * The editor's formatting toolbar.
 *
 * Every control here comes from StarterKit — marks, headings, lists, blockquote, code block, link and
 * the rule — so the toolbar adds no extensions of its own. Undo/redo are the *collaborative* ones:
 * StarterKit's own history is switched off where this editor is built, because a shared undo stack must
 * not let one person undo another's edits.
 *
 * Active states come from `useEditorState` rather than calling `editor.isActive(…)` during render. That
 * matters: `isActive` is read from the current selection, which changes without changing the document,
 * and only this hook subscribes a component to those transactions.
 */
export function EditorToolbar({ editor }: { editor: Editor }): React.JSX.Element {
  const [linkOpen, setLinkOpen] = useState(false)
  const [href, setHref] = useState('')

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      bold: ctx.editor.isActive('bold'),
      italic: ctx.editor.isActive('italic'),
      underline: ctx.editor.isActive('underline'),
      strike: ctx.editor.isActive('strike'),
      code: ctx.editor.isActive('code'),
      codeBlock: ctx.editor.isActive('codeBlock'),
      blockquote: ctx.editor.isActive('blockquote'),
      bulletList: ctx.editor.isActive('bulletList'),
      orderedList: ctx.editor.isActive('orderedList'),
      link: ctx.editor.isActive('link'),
      h1: ctx.editor.isActive('heading', { level: 1 }),
      h2: ctx.editor.isActive('heading', { level: 2 }),
      h3: ctx.editor.isActive('heading', { level: 3 }),
      canUndo: ctx.editor.can().undo(),
      canRedo: ctx.editor.can().redo(),
    }),
  })

  const chain = () => editor.chain().focus()

  const applyLink = (): void => {
    const url = href.trim()
    if (!url) chain().extendMarkRange('link').unsetLink().run()
    else chain().extendMarkRange('link').setLink({ href: url }).run()
    setLinkOpen(false)
    setHref('')
  }

  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5">
        <Tool label="Undo" onClick={() => chain().undo().run()} disabled={!state.canUndo}>
          <Undo2 />
        </Tool>
        <Tool label="Redo" onClick={() => chain().redo().run()} disabled={!state.canRedo}>
          <Redo2 />
        </Tool>

        <Divider />
        <Tool label="Heading 1" active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
          <Heading1 />
        </Tool>
        <Tool label="Heading 2" active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
          <Heading2 />
        </Tool>
        <Tool label="Heading 3" active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
          <Heading3 />
        </Tool>

        <Divider />
        <Tool label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
          <Bold />
        </Tool>
        <Tool label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}>
          <Italic />
        </Tool>
        <Tool label="Underline" active={state.underline} onClick={() => chain().toggleUnderline().run()}>
          <Underline />
        </Tool>
        <Tool label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()}>
          <Strikethrough />
        </Tool>
        <Tool label="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}>
          <Code />
        </Tool>

        <Divider />
        <Tool label="Bullet list" active={state.bulletList} onClick={() => chain().toggleBulletList().run()}>
          <List />
        </Tool>
        <Tool label="Numbered list" active={state.orderedList} onClick={() => chain().toggleOrderedList().run()}>
          <ListOrdered />
        </Tool>
        <Tool label="Quote" active={state.blockquote} onClick={() => chain().toggleBlockquote().run()}>
          <TextQuote />
        </Tool>
        <Tool label="Code block" active={state.codeBlock} onClick={() => chain().toggleCodeBlock().run()}>
          <SquareCode />
        </Tool>
        <Tool label="Divider" onClick={() => chain().setHorizontalRule().run()}>
          <Minus />
        </Tool>

        <Divider />
        {state.link ? (
          <Tool label="Remove link" active onClick={() => chain().extendMarkRange('link').unsetLink().run()}>
            <Link2Off />
          </Tool>
        ) : (
          <Tool
            label="Add link"
            active={linkOpen}
            onClick={() => {
              setHref(editor.getAttributes('link').href ?? '')
              setLinkOpen((o) => !o)
            }}
          >
            <Link2 />
          </Tool>
        )}
      </div>

      {linkOpen && (
        <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
          <input
            autoFocus
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLink()
              if (e.key === 'Escape') setLinkOpen(false)
            }}
            placeholder="https://…"
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="button"
            onClick={applyLink}
            className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  )
}

function Divider(): React.JSX.Element {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
}

function Tool({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded text-muted-foreground transition-colors',
        '[&>svg]:size-4',
        disabled ? 'opacity-40' : 'hover:bg-muted hover:text-foreground',
        active && 'bg-muted text-foreground',
      )}
    >
      {children}
    </button>
  )
}
