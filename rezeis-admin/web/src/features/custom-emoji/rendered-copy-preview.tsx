/**
 * RenderedCopyPreview
 * ───────────────────
 * Read-only preview of broadcast copy, showing it the way the RECIPIENT will
 * read it rather than as `:slug:` shortcodes.
 *
 * WHY IT NO LONGER DRAWS THE PACK PICTURE FOR EVERY KNOWN SLUG
 *
 * The pack artwork is a panel asset — it never leaves the panel. What travels
 * to Telegram is a `<tg-emoji>` tag, and the animated emoji only appears when
 * the entry has a `custom_emoji_id` AND the bot owner has Premium. Without
 * either, the recipient gets the plain carrier glyph:
 *
 *     carrier = the entry's own fallback glyph, else '⭐' when it has an id,
 *               else nothing — the token is undeliverable
 *
 * This preview used to draw the downloaded picture for every slug it
 * recognised, without asking either question. So an entry with a fallback
 * glyph but NO `custom_emoji_id` — exactly the state importing an ordinary
 * sticker pack leaves behind — looked animated here while every recipient got
 * a bare glyph. A broadcast goes to thousands of people and this preview is
 * the only thing the operator checks before pressing send, so a preview that
 * flatters is worse than no preview at all: it manufactures confidence
 * precisely where a mistake is most expensive.
 *
 * WHERE THE DECISION LIVES NOW
 *
 * Not here. Each token is resolved by `renderEmojiField` — the same call the
 * copy FIELDS make through `EmojiFieldOverlay`, over the same
 * `resolveEmojiDelivery` rules the backend renderer mirrors. The field and the
 * preview sitting under it therefore cannot drift apart: there is one rule set,
 * not three. This file only draws the parts it is handed.
 *
 * Its one addition is animation. `renderEmojiField` decides THAT a token
 * arrives as a custom emoji and hands back the still image; a preview has room
 * to play the Lottie / `.webm` where an input's overlay does not, so the
 * animated forms are looked back up by token and handed to `EmojiPreview`.
 * That is presentation only — never a second opinion about deliverability.
 *
 * `mode: 'text'` throughout: this previews message bodies, which may carry
 * `custom_emoji` entities. Inline-button captions cannot, and are previewed by
 * `EmojiFieldOverlay` in `buttonLabel` mode instead.
 */
import { useMemo, type JSX } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

import { useEmojiCatalog, type EmojiArt } from './emoji-catalog'
import { EmojiPreview } from './emoji-preview'
import { renderEmojiField, type EmojiFieldPart } from './emoji-field-render'

// The catalog — the three queries, their schemas and the Premium fallback —
// lives in `./emoji-catalog`, shared with the in-field layer. It was declared
// here and again there, and that is precisely how this preview came to miss the
// `ready` gate the layer had already grown: one rule, two wirings.

export function RenderedCopyPreview({
  value,
  className,
}: {
  readonly value: string
  readonly className?: string
}): JSX.Element | null {
  const catalog = useEmojiCatalog()

  const parts = useMemo<readonly EmojiFieldPart[]>(
    () =>
      renderEmojiField(value, {
        slugs: catalog.slugs,
        slots: catalog.slots,
        mode: 'text',
        ownerHasPremium: catalog.ownerHasPremium,
      }).parts,
    [value, catalog],
  )

  if (value.trim().length === 0) return null

  return (
    <div
      data-testid="rendered-copy-preview"
      className={cn(
        'whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-sm leading-6',
        className,
      )}
    >
      {/*
        Until the catalog lands, the value is shown as the plain text it is.
        Rendering `parts` here instead would mark every token "sent as raw
        text" — an empty catalog is indistinguishable from "no pack defines
        this" — so the preview would accuse correct copy of being broken for
        the length of the fetch, in the same destructive styling it uses for a
        genuinely dead token. The box itself stays: `broadcast-page.tsx` places
        it as a permanent line under each field and a disappearing one would
        shift the layout on every load.
      */}
      {catalog.ready
        ? parts.map((part, index) => (
            <PreviewPart key={`${index}-${partKey(part)}`} part={part} art={catalog.art} />
          ))
        : value}
    </div>
  )
}

function partKey(part: EmojiFieldPart): string {
  return part.kind === 'text' ? part.text : part.token
}

function PreviewPart({
  part,
  art,
}: {
  readonly part: EmojiFieldPart
  readonly art: ReadonlyMap<string, EmojiArt>
}): JSX.Element {
  const { t } = useTranslation()

  if (part.kind === 'text') return <>{part.text}</>

  if (part.kind === 'image') {
    // Deliverability was already settled by `renderEmojiField`; the lookup here
    // only upgrades the still it handed back to the animation the panel holds.
    const animated = art.get(part.token)
    return (
      <EmojiPreview
        imageUrl={part.imageUrl}
        lottieUrl={animated?.lottieUrl ?? null}
        videoUrl={animated?.videoUrl ?? null}
        alt={part.token}
        className="mx-0.5 inline-block h-5 w-5 align-middle"
      />
    )
  }

  if (part.kind === 'glyph') {
    // The carrier — the entry's own glyph, or the star an id-only entry rides
    // on. This is the character that actually arrives, so it is what is shown.
    return <span title={t('emojiField.tokenGlyph', { token: part.token })}>{part.glyph}</span>
  }

  return (
    <span
      title={t(part.reason === 'unknown' ? 'emojiField.tokenUnknown' : 'emojiField.tokenDead', {
        token: part.token,
      })}
      className="rounded bg-destructive/10 px-1 font-mono text-xs text-destructive"
    >
      {part.token}
    </span>
  )
}
