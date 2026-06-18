import { useMemo } from 'react'

import { cn } from '@/lib/utils'

import { EmojiPreview } from './emoji-preview'
import { useEmojiRegistry } from './use-emoji-registry'

const SHORTCODE_RE = /^:([a-z0-9_]+):$/

/** `true` when the shortcode/value is a custom-pack emoji reference. */
export function isShortcodeEmoji(value: string): boolean {
  return SHORTCODE_RE.test(value)
}

/**
 * EmojiIconView
 * ─────────────
 * Renders a stored emoji icon value as the real emoji:
 *   • `:slug:` (custom-pack) → image / Lottie / video via `EmojiPreview`
 *     (resolved from the central emoji registry). Unknown slug → literal text.
 *   • a Unicode emoji glyph  → rendered as text.
 */
export function EmojiIconView({ value, className }: { readonly value: string; readonly className?: string }) {
  const match = SHORTCODE_RE.exec(value)
  const slug = match?.[1] ?? null
  const { packs } = useEmojiRegistry({ enabled: slug !== null })

  const emoji = useMemo(() => {
    if (slug === null) return null
    for (const pack of packs) {
      for (const e of pack.emojis) {
        if (e.slug === slug) return e
      }
    }
    return null
  }, [packs, slug])

  if (slug !== null && emoji) {
    return (
      <EmojiPreview
        imageUrl={emoji.imageUrl}
        lottieUrl={emoji.lottieUrl}
        videoUrl={emoji.videoUrl}
        alt={emoji.name}
        className={cn('bg-transparent', className)}
      />
    )
  }

  // Unicode glyph (or an unknown shortcode rendered literally).
  return (
    <span className={cn('inline-flex items-center justify-center leading-none', className)}>
      {value}
    </span>
  )
}
