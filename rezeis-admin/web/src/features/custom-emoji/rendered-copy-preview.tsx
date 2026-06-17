/**
 * RenderedCopyPreview
 * ───────────────────
 * Renders bot copy the way users will see it: `:slug:` tokens become the pack
 * glyph (image/Lottie/webm), `{{KEY}}` tokens become their unicode fallback,
 * everything else is plain text. A read-only companion to a token text field
 * so the operator sees emoji rendered instead of raw `:slug:` codes.
 *
 * Uses the shared, unit-tested tokenizer (`emoji-token-text`) so the preview
 * splits copy exactly like the delivery-time renderer.
 */
import { Fragment, useMemo, type JSX } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EmojiPreview } from './emoji-preview'
import { parseTokens } from './emoji-token-text'

interface PackEmojiLite {
  readonly slug: string
  readonly name: string
  readonly imageUrl: string
  readonly lottieUrl: string | null
  readonly videoUrl: string | null
}
interface BotEmojiLite {
  readonly key: string
  readonly unicode: string
}

const PACKS_KEY = ['admin', 'custom-emoji', 'packs'] as const
const EMOJIS_KEY = ['admin', 'bot-config', 'emojis'] as const

export function RenderedCopyPreview({
  value,
  className,
}: {
  readonly value: string
  readonly className?: string
}): JSX.Element | null {
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

  if (value.trim().length === 0) return null

  const segments = parseTokens(value)

  return (
    <div className={cn('whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-sm leading-6', className)}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <Fragment key={i}>{seg.text}</Fragment>
        if (seg.kind === 'slug') {
          const hit = slugMap.get(seg.name)
          if (hit) {
            return (
              <EmojiPreview
                key={i}
                imageUrl={hit.imageUrl}
                lottieUrl={hit.lottieUrl}
                videoUrl={hit.videoUrl}
                alt={seg.raw}
                className="mx-0.5 inline-block h-5 w-5 align-middle"
              />
            )
          }
          return <Fragment key={i}>{seg.raw}</Fragment>
        }
        const unicode = keyMap.get(seg.name)
        return <Fragment key={i}>{unicode ?? seg.raw}</Fragment>
      })}
    </div>
  )
}
