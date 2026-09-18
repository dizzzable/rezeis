/**
 * The QR tab's preview as layout: where the page puts it, and how its five
 * samples are laid out. WHAT each sample draws is `qr-style-section.test.tsx`'s
 * business; this file holds the arrangement the owner asked for — one strip of
 * identical tiles, each code at its true size, the way through a strip that
 * does not fit, and nothing moving when the step-down note comes and goes.
 *
 * jsdom lays nothing out, so what is held here is the structure the layout
 * stands on: one strip, five tiles sharing one stage size, the size written
 * under each code, the caption block reserved, the note placed after
 * everything it could push, and the sideways hint measured off the strip
 * itself — with measurements this file supplies. What it all looks like in a
 * browser is for the harness screenshots, not for a DOM without geometry.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import api from '@/lib/api'
import { en } from '@/i18n/en'
import { renderWithProviders } from '@/test/test-utils'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
// The phone preview and the effect grid mount renderers this suite has no use
// for. The phone's stand-in keeps one thing that matters here: its identity,
// which says whether the page remounted it.
vi.mock('./branding-preview', () => ({
  BrandingPreview: () => <div data-testid="branding-preview" />,
}))
vi.mock('./card-effect-section', () => ({
  CardEffectSection: () => <div data-testid="card-effect-section" />,
  CardEffectPicker: () => <div data-testid="card-effect-picker" />,
}))

import WebReiwaPage from './branding-page'
import { DEFAULT_BRANDING_DRAFT, type BrandingQrStyleDraft } from './branding-form-schema'
import {
  QR_PREVIEW_CONNECT_PX,
  QR_PREVIEW_PARTNER_ENLARGED_PX,
  QR_PREVIEW_PARTNER_MAGNIFIED_PX,
  QR_PREVIEW_PARTNER_PX,
  QR_PREVIEW_REFERRAL_PX,
  QrStylePreview,
} from './qr-style-section'

const page = en.brandingPage
const copy = en.brandingPage.qr
const NAVY_DOTS: BrandingQrStyleDraft = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderPreview(value: BrandingQrStyleDraft = NAVY_DOTS) {
  return renderWithProviders(<QrStylePreview value={value} />, { withRouter: false })
}

function only<T extends Element>(selector: string): T {
  const found = document.querySelectorAll<T>(selector)
  if (found.length !== 1) throw new Error(`expected one ${selector}, found ${found.length}`)
  return found[0] as T
}

const strip = (): HTMLElement => only<HTMLElement>('[data-qr-preview-strip]')
/** The strip's own children — a tile nested any deeper would be a second row. */
const tiles = (): HTMLElement[] => [...strip().children] as HTMLElement[]
const kindOf = (tile: Element): string | null => tile.getAttribute('data-qr-preview-tile')
const stageOf = (tile: Element): HTMLElement => {
  const stage = tile.querySelector<HTMLElement>('[data-qr-preview-stage]')
  if (stage === null) throw new Error(`the ${kindOf(tile)} tile has no stage`)
  return stage
}

/** Every sample drawn: a code still being drawn is a placeholder with no `data-qr-preview`. */
const allDrawn = () => waitFor(() => expect(document.querySelectorAll('img[data-qr-preview]')).toHaveLength(5))

/** Around a code on a standard plate: `p-4` and a 1-px border, each side. */
const STANDARD_PLATE_INSET = 17
/** The strip's `gap-3`. */
const TILE_GAP = 12

const TRUE_SIZE: Record<string, number> = {
  referral: QR_PREVIEW_REFERRAL_PX,
  partner: QR_PREVIEW_PARTNER_PX,
  'partner-magnified': QR_PREVIEW_PARTNER_MAGNIFIED_PX,
  'partner-enlarged': QR_PREVIEW_PARTNER_ENLARGED_PX,
  connect: QR_PREVIEW_CONNECT_PX,
}

describe('QR preview — one strip of identical tiles', () => {
  it('lays the five samples out in one strip, in the order the style reaches them, the plain connect code last', async () => {
    renderPreview()
    await allDrawn()
    expect(tiles().map(kindOf)).toEqual(['referral', 'partner', 'partner-magnified', 'partner-enlarged', 'connect'])
    // One row that scrolls and snaps, never one that wraps into a second.
    expect(strip()).toHaveClass('flex', 'overflow-x-auto', 'snap-x', 'snap-mandatory')
    expect(strip()).not.toHaveClass('flex-wrap')
    for (const tile of tiles()) expect(tile).toHaveClass('shrink-0', 'snap-start')
  })

  it('gives every tile the same square stage, large enough for the largest code on its plate', async () => {
    renderPreview()
    await allDrawn()
    const stages = tiles().map(stageOf)
    const side = parseFloat(stages[0]?.style.width ?? '')
    expect(side).toBeGreaterThanOrEqual(QR_PREVIEW_PARTNER_ENLARGED_PX + 2 * STANDARD_PLATE_INSET)
    for (const [index, stage] of stages.entries()) {
      expect([kindOf(tiles()[index] as HTMLElement), stage.style.width, stage.style.height]).toEqual([
        kindOf(tiles()[index] as HTMLElement),
        `${side}px`,
        `${side}px`,
      ])
      // The tile is its stage's width: identical tiles, not tiles as wide as their captions.
      expect(tiles()[index]?.style.width).toBe(`${side}px`)
      // And the plate sits in the middle of it.
      expect(stage).toHaveClass('grid', 'place-items-center')
    }
  })

  it('draws each code at its true size, on the stage of its own tile', async () => {
    renderPreview()
    await allDrawn()
    for (const tile of tiles()) {
      const kind = kindOf(tile) ?? ''
      const images = tile.querySelectorAll('img[data-qr-preview]')
      expect(images, `the ${kind} tile`).toHaveLength(1)
      const image = images[0] as HTMLImageElement
      expect(image.getAttribute('data-qr-preview')).toBe(kind)
      expect(stageOf(tile).contains(image)).toBe(true)
      expect([kind, image.getAttribute('width'), image.getAttribute('height')]).toEqual([
        kind,
        String(TRUE_SIZE[kind]),
        String(TRUE_SIZE[kind]),
      ])
    }
  })

  it('writes under each code the size it is shown at in the cabinet', async () => {
    renderPreview()
    const size = (kind: string): string | null | undefined =>
      strip().querySelector(`[data-qr-preview-tile="${kind}"] [data-qr-preview-size]`)?.textContent
    expect(size('referral')).toBe(`${QR_PREVIEW_REFERRAL_PX} px`)
    expect(size('partner')).toBe(`${QR_PREVIEW_PARTNER_PX} px`)
    // The magnified copy is the card's code blown up: both numbers, the true one first.
    expect(size('partner-magnified')).toBe(`${QR_PREVIEW_PARTNER_PX} → ${QR_PREVIEW_PARTNER_MAGNIFIED_PX} px`)
    expect(size('partner-enlarged')).toBe(`${QR_PREVIEW_PARTNER_ENLARGED_PX} px`)
    expect(size('connect')).toBe(`${QR_PREVIEW_CONNECT_PX} px`)
  })

  it('keeps every caption whole in the page, in a block two lines tall whatever it says', () => {
    renderPreview()
    const captions = tiles().map((tile) => tile.querySelector<HTMLElement>('[data-qr-preview-caption]'))
    expect(captions.map((caption) => caption?.textContent)).toEqual([
      copy.previewReferral,
      copy.previewPartner,
      copy.previewPartnerMagnified,
      copy.previewPartnerEnlarged,
      copy.previewConnect,
    ])
    for (const caption of captions) {
      // Two lines reserved and two shown; the rest on hover, or while the strip has keyboard focus.
      expect(caption).toHaveClass(
        'min-h-8',
        'line-clamp-2',
        'group-hover/tile:line-clamp-none',
        'group-focus-visible/strip:line-clamp-none',
      )
      // The figure's own caption, so the tile is named by it.
      expect(caption?.closest('figcaption')?.parentElement).toBe(caption?.closest('[data-qr-preview-tile]'))
    }
  })

  it('takes its width from the card, never from its five tiles', () => {
    renderPreview()
    // Without inline-size containment the tiles are the strip's minimum width,
    // and in the one-column page under `lg` the page grid widened to fit them —
    // 1626 px at a 400-px viewport — instead of letting the strip scroll.
    expect(strip().parentElement).toHaveClass('[contain:inline-size]')
  })
})

describe('QR preview — notes that come and go', () => {
  it('puts the step-down note after everything else in the card, so nothing moves when it appears', async () => {
    // A refused colour as well: both notes at once, and the step-down one still last.
    renderPreview({ ...NAVY_DOTS, dark: '#cccccc' })
    const note = await waitFor(() => only<HTMLElement>('[data-qr-step-down]'))
    expect(note).toHaveTextContent(copy.previewPartnerStepDown)
    expect(screen.getByText(copy.previewRefused)).toBeInTheDocument()

    const card = only<HTMLElement>('[data-qr-preview-card]')
    const after = [...card.querySelectorAll('*')].filter(
      (element) =>
        element !== note &&
        !note.contains(element) &&
        (element.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
    )
    expect(after.map((element) => element.outerHTML.slice(0, 80))).toEqual([])
  })

  it('keeps the explanation of the samples one hover away, named for what it explains', async () => {
    const user = userEvent.setup()
    renderPreview()
    // Not on the card itself: the sticky column has to fit a 1280×800 screen.
    expect(screen.queryByText(copy.previewHint)).toBeNull()
    await user.hover(screen.getByRole('button', { name: copy.previewHintLabel }))
    expect((await screen.findAllByText(copy.previewHint)).length).toBeGreaterThan(0)
  })
})

/**
 * A `ResizeObserver` the case fires by hand. jsdom has none, and no layout to
 * observe; the strip's measurements are the ones `layOut` gives it.
 */
class HandFiredResizeObserver {
  static readonly live: HandFiredResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(private readonly callback: ResizeObserverCallback) {
    HandFiredResizeObserver.live.push(this)
  }
  observe(target: Element): void {
    this.targets.push(target)
  }
  unobserve(target: Element): void {
    this.targets.splice(this.targets.indexOf(target), 1)
  }
  disconnect(): void {
    this.targets.length = 0
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function observerOf(element: Element): HandFiredResizeObserver {
  const observer = HandFiredResizeObserver.live.find((candidate) => candidate.targets.includes(element))
  if (observer === undefined) throw new Error('nothing observes the strip')
  return observer
}

function layOut(element: HTMLElement, box: { scrollWidth: number; clientWidth: number; scrollLeft: number }): void {
  for (const [key, value] of Object.entries(box)) {
    Object.defineProperty(element, key, { configurable: true, value })
  }
}

describe('QR preview — the way through a strip that does not fit', () => {
  const tileWidth = (): number => parseFloat(tiles()[0]?.style.width ?? '')

  function renderMeasured(box: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
    HandFiredResizeObserver.live.length = 0
    vi.stubGlobal('ResizeObserver', HandFiredResizeObserver)
    renderPreview()
    layOut(strip(), box)
    act(() => observerOf(strip()).fire())
  }

  const previous = () => screen.getByRole('button', { name: copy.previewPrevious })
  const next = () => screen.getByRole('button', { name: copy.previewNext })

  it('says so, and offers arrows that name the strip they move, while the strip is wider than its box', () => {
    renderMeasured({ scrollWidth: 1626, clientWidth: 358, scrollLeft: 0 })
    expect(only('[data-qr-preview-scroll]')).toHaveTextContent(copy.previewScrollHint)
    expect(previous()).toBeDisabled()
    expect(next()).toBeEnabled()
    expect(next()).toHaveAttribute('aria-controls', strip().id)
    expect(previous()).toHaveAttribute('aria-controls', strip().id)
    // A keyboard reaches the strip itself, and a screen reader hears what it holds.
    expect(strip()).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('region', { name: copy.previewStrip })).toBe(strip())
  })

  it('says nothing about scrolling once every sample fits', () => {
    renderMeasured({ scrollWidth: 1626, clientWidth: 1626, scrollLeft: 0 })
    expect(document.querySelector('[data-qr-preview-scroll]')).toBeNull()
    expect(screen.queryByText(copy.previewScrollHint)).toBeNull()
  })

  it('moves one tile per press, and stops at either end', async () => {
    const user = userEvent.setup()
    renderMeasured({ scrollWidth: 1626, clientWidth: 358, scrollLeft: 0 })
    const scrollBy = vi.fn()
    Object.defineProperty(strip(), 'scrollBy', { configurable: true, value: scrollBy })
    expect(strip()).toHaveClass('gap-3')

    await user.click(next())
    expect(scrollBy).toHaveBeenCalledTimes(1)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: tileWidth() + TILE_GAP })

    // Somewhere in the middle: both ways open.
    layOut(strip(), { scrollWidth: 1626, clientWidth: 358, scrollLeft: 636 })
    fireEvent.scroll(strip())
    expect(previous()).toBeEnabled()
    expect(next()).toBeEnabled()

    // At the far end: nowhere further to go.
    layOut(strip(), { scrollWidth: 1626, clientWidth: 358, scrollLeft: 1268 })
    fireEvent.scroll(strip())
    expect(next()).toBeDisabled()
    expect(previous()).toBeEnabled()

    await user.click(previous())
    expect(scrollBy).toHaveBeenCalledTimes(2)
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -(tileWidth() + TILE_GAP) })
  })
})

describe('QR preview — where the page puts it', () => {
  beforeAll(() => {
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>
    proto['hasPointerCapture'] ??= () => false
    proto['setPointerCapture'] ??= () => {}
    proto['releasePointerCapture'] ??= () => {}
    proto['scrollIntoView'] ??= () => {}
  })

  it('shows the samples in the sticky column beside the controls, in place of the phone, and gives the phone back after', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockResolvedValue({ data: { ...DEFAULT_BRANDING_DRAFT, qrStyle: NAVY_DOTS } })
    renderWithProviders(<WebReiwaPage />)
    await screen.findByRole('heading', { name: /WEB Reiwa/ })

    const phone = screen.getByTestId('branding-preview')
    const phoneCard = phone.closest('[data-concept-surface="card"]')
    if (phoneCard === null) throw new Error('the phone preview is not in a card')
    expect(document.querySelector('[data-qr-preview-card]')).toBeNull()
    expect(phoneCard).not.toHaveClass('hidden')

    await user.click(screen.getByRole('tab', { name: page.tabs.qr }))
    const preview = await waitFor(() => only<HTMLElement>('[data-qr-preview-card]'))
    await waitFor(() => expect(preview.querySelectorAll('img[data-qr-preview]')).toHaveLength(5))
    // Every sample on the page is in it: one preview, not a second one under the controls.
    expect(document.querySelectorAll('img[data-qr-preview]')).toHaveLength(5)

    // Beside the controls, not in their card...
    const controls = only<HTMLElement>('[data-qr-logo-controls]').closest('[data-concept-surface="card"]')
    expect(controls?.contains(preview)).toBe(false)
    // ...but in the column the phone occupies on every other tab — the sticky
    // one, which stays in view while the controls scroll — with the phone,
    // which has no QR code on it, out of the way.
    expect(preview.parentElement).toBe(phoneCard.parentElement)
    expect(preview.parentElement).toHaveClass('lg:sticky')
    expect(phoneCard).toHaveClass('hidden')

    await user.click(screen.getByRole('tab', { name: page.tabs.brand }))
    expect(document.querySelector('[data-qr-preview-card]')).toBeNull()
    expect(phoneCard).not.toHaveClass('hidden')
    // Hidden on the QR tab, never unmounted: the same phone throughout.
    expect(screen.getByTestId('branding-preview')).toBe(phone)
  }, 30_000)
})
