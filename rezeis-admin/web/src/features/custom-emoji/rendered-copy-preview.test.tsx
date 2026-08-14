/**
 * The broadcast preview must not flatter the copy.
 *
 * A broadcast goes to thousands of people at once and this preview is the only
 * thing the operator looks at before pressing send, so every way it could
 * overstate what arrives is worth a spec of its own. It used to draw the pack
 * picture for every slug it recognised — without asking whether the entry
 * carries a `custom_emoji_id`, and without asking whether the bot owner has
 * Premium — so the two states that deliver a plain character looked animated.
 *
 * Each spec below pins one delivery outcome, and each is written so it fails
 * against that old behaviour:
 *
 *   • a glyph with no id — what importing an ordinary sticker pack leaves —
 *     must be the GLYPH, not the picture;
 *   • an entry carrying neither field must stay marked raw text, because raw
 *     text is precisely what the recipient receives;
 *   • a non-Premium owner collapses EVERY token to its carrier, the star that
 *     an id-only entry rides on included;
 *   • a slug no pack defines stays readable and is marked as unsent;
 *   • and the one state that really is the picture stays the picture — drawn
 *     because the panel asked about Premium, not because the slug was known.
 *
 * Negative assertions ("no picture here") are always anchored behind a `find*`
 * that only resolves once the catalog has loaded. Before it loads, every token
 * renders as raw text and a bare `queryByRole('img')` would pass without
 * proving anything.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { packsPayload, type PackEmojiFixture } from './emoji-catalog.fixtures'
import { RenderedCopyPreview } from './rendered-copy-preview'

// The row shape and the payload builder are shared with the field-layer specs
// (`./emoji-catalog.fixtures`); the entries below are this suite's own, named
// for the delivery state each one exercises.

/** The state a plain sticker-set import leaves behind: a glyph, and no id. */
const GLYPH_ONLY: PackEmojiFixture = {
  slug: 'sticker_import',
  fallback: '📣',
  customEmojiId: null,
}

/** Fully deliverable: Telegram wraps the glyph in a `<tg-emoji>` tag. */
const WITH_ID: PackEmojiFixture = {
  slug: 'live_emoji',
  fallback: '🎉',
  customEmojiId: '5188621441926438751',
}

/** An id and no glyph of its own — the renderers carry it on a star. */
const ID_ONLY: PackEmojiFixture = {
  slug: 'id_only',
  fallback: null,
  customEmojiId: '5188621441926438752',
}

/** Neither field: the shortcode itself is what goes out. */
const DEAD: PackEmojiFixture = {
  slug: 'dead_entry',
  fallback: null,
  customEmojiId: null,
}


/**
 * The catalog the preview reads: the packs, the `{{KEY}}` slots, and the
 * owner's Premium flag — the last one being the question the old preview never
 * asked. Returns the spy so a spec can assert it really was asked.
 */
function mockCatalog(
  emojis: readonly PackEmojiFixture[],
  ownerHasPremium: boolean,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/custom-emoji/packs') return packsPayload(emojis)
    if (path === '/admin/bot-config/emoji-studio') {
      return { data: { slots: [], ownerHasPremium } }
    }
    return { data: [] }
  })
}

describe('the preview says nothing until it has something to say', () => {
  /**
   * The box stays — `broadcast-page.tsx` places it as a permanent line under
   * each field, and one that appears late would shift the layout on every load
   * — but until the catalog lands it may only show the copy as written.
   *
   * Rendering the resolved parts early would mark every token "sent as raw
   * text" in destructive styling, because an empty catalog is indistinguishable
   * from "no pack defines this slug". That is the same marking a genuinely dead
   * token gets, so firing it on correct copy is how an operator learns to read
   * past it.
   */
  it('shows the copy as written while the catalog is still loading', async () => {
    let releasePacks: (() => void) | undefined
    const packsArrived = new Promise<void>((resolve) => {
      releasePacks = resolve
    })
    expect(releasePacks).toBeDefined()

    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/admin/custom-emoji/packs') {
        await packsArrived
        return packsPayload([GLYPH_ONLY])
      }
      if (path === '/admin/bot-config/emoji-studio') {
        return { data: { slots: [], ownerHasPremium: true } }
      }
      return { data: [] }
    })

    renderWithProviders(<RenderedCopyPreview value=":sticker_import: Big news" />)

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(preview).toHaveTextContent(':sticker_import: Big news')
    expect(within(preview).queryByTitle(/sent as raw text/i)).not.toBeInTheDocument()

    releasePacks?.()

    // And once it knows, it answers — with the glyph, which is what this entry
    // actually delivers.
    expect(await within(preview).findByTitle(/^:sticker_import: → fallback glyph/)).toBeInTheDocument()
  })
})

describe('the broadcast preview shows what is delivered, not the pack artwork', () => {
  it('draws an entry that has a glyph but no custom_emoji_id as the GLYPH', async () => {
    mockCatalog([GLYPH_ONLY], true)
    renderWithProviders(<RenderedCopyPreview value=":sticker_import: Big news" />)

    // Resolves only once the catalog is in, so the checks below are not racing
    // an unloaded preview that shows raw tokens and no pictures either way.
    const glyph = await screen.findByTitle(/^:sticker_import: → fallback glyph/)
    expect(glyph).toHaveTextContent('📣')

    // The pack picture is a panel asset — it never reaches the recipient here.
    const preview = screen.getByTestId('rendered-copy-preview')
    expect(within(preview).queryByRole('img')).not.toBeInTheDocument()
    expect(preview).toHaveTextContent('📣 Big news')
    expect(preview.textContent).not.toContain(':sticker_import:')
  })

  it('leaves an entry with neither glyph nor id as marked raw text', async () => {
    mockCatalog([DEAD], true)
    renderWithProviders(<RenderedCopyPreview value=":dead_entry: Big news" />)

    const dead = await screen.findByTitle(/^:dead_entry: → sent as raw text/)
    expect(dead).toHaveTextContent(':dead_entry:')

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(within(preview).queryByRole('img')).not.toBeInTheDocument()
    expect(preview).toHaveTextContent(':dead_entry: Big news')
  })

  it('collapses every token to its carrier when the bot owner has no Premium', async () => {
    mockCatalog([GLYPH_ONLY, WITH_ID, ID_ONLY], false)
    renderWithProviders(
      <RenderedCopyPreview value=":sticker_import: :live_emoji: :id_only: Big news" />,
    )

    // Even the entry that IS fully deliverable degrades: without Premium the
    // `<tg-emoji>` tag is never emitted, so its carrier glyph is what arrives.
    const carried = await screen.findByTitle(/^:live_emoji: → fallback glyph/)
    expect(carried).toHaveTextContent('🎉')

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(within(preview).queryByRole('img')).not.toBeInTheDocument()
    // …including the star an id-only entry is painted on: that star is the
    // character the recipient reads, so drawing nothing would lie the other way.
    expect(preview).toHaveTextContent('📣 🎉 ⭐ Big news')
  })

  it('leaves a slug no pack defines readable, and marks it as sent raw', async () => {
    mockCatalog([GLYPH_ONLY], true)
    renderWithProviders(<RenderedCopyPreview value=":sticker_import: :nowhere: Big news" />)

    // Anchored on the KNOWN token, not the unknown one: until the catalog
    // lands every slug looks unknown and is marked as such, so waiting on
    // `:nowhere:` itself would resolve against an unloaded preview and prove
    // nothing about the rest of this spec.
    await screen.findByTitle(/^:sticker_import: → fallback glyph/)

    const unknown = screen.getByTitle(/^:nowhere: → unknown shortcode/)
    expect(unknown).toHaveTextContent(':nowhere:')

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(within(preview).queryByRole('img')).not.toBeInTheDocument()
    expect(preview).toHaveTextContent('📣 :nowhere: Big news')
  })

  it('draws the picture only for an id under a Premium owner, having asked first', async () => {
    const get = mockCatalog([WITH_ID], true)
    renderWithProviders(<RenderedCopyPreview value=":live_emoji: Big news" />)

    const picture = await screen.findByAltText(':live_emoji:')
    expect(picture).toHaveAttribute('src', '/uploads/emoji/live_emoji.webp')

    const preview = screen.getByTestId('rendered-copy-preview')
    expect(preview).toHaveTextContent('Big news')
    expect(preview.textContent).not.toContain(':live_emoji:')

    // The falsifier for THIS state. The old preview drew the picture here too,
    // but only because the slug was known — it never read the Premium flag at
    // all, so it was right by accident and wrong in the specs above. Pinning
    // the question makes the right answer here a consequence of asking it.
    expect(get).toHaveBeenCalledWith('/admin/bot-config/emoji-studio')
  })
})
