/**
 * EmojiTextEditor — WYSIWYG token field.
 *
 * A `contentEditable` drop-in for a `<textarea>` that renders `:slug:` and
 * `{{KEY}}` tokens as inline glyph chips while editing, and serializes back to
 * the exact token string on every change (`value`/`onChange` controlled). The
 * stored value is byte-identical to the plain-token format — see
 * `emoji-token-text.ts` (`segmentsToString(parseTokens(v)) === v`).
 *
 * Design choices that keep `contentEditable` predictable:
 *   - The DOM is (re)rendered ONLY when the external `value` differs from what
 *     the editor currently holds — never on every keystroke — so the caret is
 *     left alone while typing.
 *   - Enter inserts a literal "\n" (pre-wrap) instead of letting the browser
 *     spawn <div>/<br>, so serialization stays deterministic.
 *   - Chips are static `<img>` (slug) / unicode text (key) — no React owns
 *     nodes inside the editable region.
 *   - Manually-typed tokens are normalized into chips on blur.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { parseTokens, type TokenSegment } from './emoji-token-text'

export interface EmojiTextEditorHandle {
  /** Insert a raw token (`:slug:` / `{{KEY}}`) at the caret. */
  insertToken: (raw: string) => void
}

interface PackEmojiLite {
  readonly slug: string
  readonly imageUrl: string
  readonly fallback: string | null
}
interface BotEmojiLite {
  readonly key: string
  readonly unicode: string
}

const PACKS_KEY = ['admin', 'custom-emoji', 'packs'] as const
const EMOJIS_KEY = ['admin', 'bot-config', 'emojis'] as const

interface EmojiTextEditorProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string
  readonly ariaLabel?: string
  readonly id?: string
  readonly className?: string
}

export const EmojiTextEditor = forwardRef<EmojiTextEditorHandle, EmojiTextEditorProps>(
  function EmojiTextEditor({ value, onChange, placeholder, ariaLabel, id, className }, ref): JSX.Element {
    const editorRef = useRef<HTMLDivElement | null>(null)
    // Tracks the value the DOM currently represents, so we only re-render the
    // editable region on a genuine external change (never mid-typing).
    const domValueRef = useRef<string>('\u0000')

    const { data: packs } = useQuery<ReadonlyArray<{ emojis: readonly PackEmojiLite[] }>>({
      queryKey: PACKS_KEY,
      queryFn: async () =>
        (await api.get<ReadonlyArray<{ emojis: readonly PackEmojiLite[] }>>('/admin/custom-emoji/packs')).data,
      staleTime: 60_000,
    })
    const { data: emojis } = useQuery<ReadonlyArray<BotEmojiLite>>({
      queryKey: EMOJIS_KEY,
      queryFn: async () => (await api.get<ReadonlyArray<BotEmojiLite>>('/admin/bot-config/emojis')).data,
      staleTime: 60_000,
    })

    const slugMap = useMemo(() => {
      const map = new Map<string, PackEmojiLite>()
      for (const pack of Array.isArray(packs) ? packs : []) for (const e of pack.emojis) map.set(e.slug, e)
      return map
    }, [packs])
    const keyMap = useMemo(() => {
      const map = new Map<string, string>()
      for (const e of Array.isArray(emojis) ? emojis : []) map.set(e.key, e.unicode)
      return map
    }, [emojis])

    // Build a chip / text node for a segment.
    const renderSegment = useMemo(
      () =>
        (seg: TokenSegment): Node => {
          if (seg.type === 'text') return document.createTextNode(seg.text)
          const chip = document.createElement('span')
          chip.setAttribute('contenteditable', 'false')
          chip.setAttribute('data-token', seg.raw)
          chip.className =
            'mx-0.5 inline-flex h-5 w-5 select-none items-center justify-center align-middle'
          if (seg.kind === 'slug') {
            const hit = slugMap.get(seg.name)
            if (hit) {
              const img = document.createElement('img')
              img.src = hit.imageUrl
              img.alt = seg.raw
              img.className = 'h-5 w-5 object-contain'
              chip.appendChild(img)
              chip.title = `:${seg.name}:`
              return chip
            }
          } else {
            const unicode = keyMap.get(seg.name)
            if (unicode) {
              chip.textContent = unicode
              chip.title = `{{${seg.name}}}`
              chip.className =
                'mx-0.5 inline-flex select-none items-center justify-center align-middle text-base'
              return chip
            }
          }
          // Unknown token → keep the literal text (Property 4 passthrough).
          return document.createTextNode(seg.raw)
        },
      [slugMap, keyMap],
    )

    const renderValue = useMemo(
      () =>
        (next: string): void => {
          const node = editorRef.current
          if (!node) return
          node.textContent = ''
          for (const seg of parseTokens(next)) node.appendChild(renderSegment(seg))
          domValueRef.current = next
        },
      [renderSegment],
    )

    // Re-render the editable DOM only when the external value (or the resolver
    // maps) changed — keeps the caret stable while the operator types.
    useEffect(() => {
      if (value !== domValueRef.current) renderValue(value)
    }, [value, renderValue])

    const serialize = (): string => {
      const node = editorRef.current
      if (!node) return ''
      return serializeEditor(node)
    }

    const emitChange = (): void => {
      const next = serialize()
      domValueRef.current = next
      onChange(next)
    }

    useImperativeHandle(ref, () => ({
      insertToken: (raw: string): void => {
        const node = editorRef.current
        if (!node) return
        node.focus()
        const seg = parseTokens(raw)[0] ?? { type: 'text', text: raw }
        insertNodeAtCaret(node, renderSegment(seg))
        emitChange()
      },
    }))

    return (
      <div
        ref={editorRef}
        id={id}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        onInput={emitChange}
        onBlur={() => {
          // Normalize any manually-typed tokens into chips (caret not critical).
          const next = serialize()
          domValueRef.current = '\u0000'
          renderValue(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            insertNodeAtCaret(editorRef.current, document.createTextNode('\n'))
            emitChange()
          }
        }}
        className={cn(
          'min-h-[80px] w-full whitespace-pre-wrap break-words rounded-md border border-input bg-transparent px-3 py-2 text-sm',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
          className,
        )}
      />
    )
  },
)

/** Serialize the editable DOM to a token string (text + chip `data-token`). */
function serializeEditor(root: HTMLElement): string {
  let out = ''
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? ''
      } else if (child instanceof HTMLElement) {
        const token = child.getAttribute('data-token')
        if (token !== null) {
          out += token
        } else if (child.tagName === 'BR') {
          out += '\n'
        } else {
          // contentEditable may wrap lines in <div>; treat as a line break.
          if (out.length > 0 && !out.endsWith('\n') && isBlock(child)) out += '\n'
          walk(child)
        }
      }
    }
  }
  walk(root)
  return out
}

function isBlock(el: HTMLElement): boolean {
  return el.tagName === 'DIV' || el.tagName === 'P'
}

/** Insert a node at the current caret inside `editor` (append if no selection). */
function insertNodeAtCaret(editor: HTMLElement | null, node: Node): void {
  if (!editor) return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) {
    editor.appendChild(node)
    return
  }
  const range = selection.getRangeAt(0)
  range.deleteContents()
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}
