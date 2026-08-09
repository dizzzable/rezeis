/**
 * What the live preview's card strip is a preview OF.
 *
 * The per-position section states its own contract to the operator: "slot 1 →
 * the first subscription, slot 2 → the second, and so on; subscriptions beyond
 * the configured slots use the global card background above." So a single
 * configured slot already means TWO designs are live — the slot's, and the
 * global one every later subscription gets.
 *
 * The strip used to page over slots alone. With one slot that is one page: no
 * dots, nothing to swipe, and no way to see the design most subscribers
 * actually get. The operator who reported this had exactly one slot, in
 * override mode, and concluded the preview was broken; the control was fine,
 * the page model was short by one.
 *
 * These tests pin the model (one page per slot plus one trailing page for the
 * global fallback), what that trailing page renders (the GLOBAL artwork, never
 * a slot's), what it is called (named for the subscriptions it covers, not
 * "Card N"), and the constraint the whole feature is built around: only the
 * displayed page may hold a live renderer.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'

import { renderWithProviders } from '@/test/test-utils'
import { i18n } from '@/i18n/i18n'
import { en } from '@/i18n/en'
import { ru } from '@/i18n/ru'

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: [] }),
}))

vi.mock('./card-effect-registry', async () => {
  const actual =
    await vi.importActual<typeof import('./card-effect-registry')>('./card-effect-registry')
  return {
    ...actual,
    // Only these two are ever selected below, and the real components would
    // spend the whole run driving a WebGL context jsdom does not have.
    CARD_EFFECT_COMPONENTS: {
      ...actual.CARD_EFFECT_COMPONENTS,
      aurora: () => <canvas data-testid="preview-effect-renderer" />,
      plasma: () => <canvas data-testid="preview-effect-renderer" />,
    },
  }
})

import { BrandingPreview } from './branding-preview'

const GLOBAL_GRADIENT = 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)'
const SLOT_GRADIENT = 'linear-gradient(135deg, #4c1d95 0%, #a855f7 100%)'
const SECOND_SLOT_GRADIENT = 'linear-gradient(135deg, #7f1d1d 0%, #ef4444 100%)'

/** The operator's reported setup: one slot, override mode, its own artwork. */
const OVERRIDE_SLOT = {
  mode: 'override' as const,
  cardEffect: 'plasma',
  cardEffectProps: {},
  cardEffectOpacity: 0.8,
  cardGradient: SLOT_GRADIENT,
}

function renderPreview(slots: readonly unknown[]) {
  return renderWithProviders(
    <BrandingPreview
      values={{
        cardGradient: GLOBAL_GRADIENT,
        cardEffect: 'aurora',
        cardEffectProps: {},
        cardEffectOpacity: 1,
        cardEffectsByIndex: slots as never,
      }}
    />,
  )
}

function dots(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('button[aria-current]'))
}

/**
 * The page for the global card background. Looked up rather than indexed so a
 * failure says which page is missing instead of "cannot click undefined".
 */
function restDot(container: HTMLElement): HTMLElement {
  const found = dots(container).find(
    (dot) => dot.dataset['previewCardDot'] === 'fallback',
  )
  expect(
    found,
    'the preview offers no page for the global card background — the design ' +
      'every subscription past the last configured slot gets',
  ).toBeDefined()
  return found!
}

function gradientOf(container: HTMLElement): string {
  const layer = container.querySelector<HTMLElement>(
    '[data-preview-card-layer="gradient"]',
  )
  return layer?.style.backgroundImage ?? ''
}

/**
 * The app boots with `resources: {}` and hydrates the dictionary
 * asynchronously, so without this every label under test would be the raw key
 * and the "is the fallback page named differently from a slot?" assertions
 * would compare two identical strings and pass for the wrong reason.
 */
beforeAll(() => {
  i18n.addResourceBundle('en', 'translation', en, true, true)
})

describe('preview card pages', () => {
  /**
   * The effect layer only commits after a capability probe that runs inside a
   * `requestAnimationFrame` and asks for a real GL context. Same treatment as
   * `branding-preview.test.tsx`: run the frame synchronously and hand the probe
   * a context, so "is a renderer mounted?" is answerable in jsdom at all.
   */
  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => ({
        getExtension: vi.fn().mockReturnValue({ loseContext: vi.fn() }),
      })) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows one page and no pager when only the global design exists', () => {
    const { container } = renderPreview([])

    expect(container.querySelectorAll('[data-preview-subscription-card]')).toHaveLength(1)
    expect(
      dots(container),
      'a pager for a single design — there is nothing to page between until a ' +
        'slot is configured',
    ).toHaveLength(0)
    // Nothing to swipe between: the drag affordance must stay off too.
    expect(container.querySelector('.cursor-grab')).toBeNull()
    expect(container.querySelector('[data-preview-card-page-label]')).toBeNull()
    expect(gradientOf(container)).toContain('rgb(6, 78, 59)')
  })

  it('adds a page for the global background as soon as one slot is configured', () => {
    const { container } = renderPreview([OVERRIDE_SLOT])

    // The report: one slot used to mean one page, so there were no dots at all
    // and nothing to swipe, even though two designs were already live.
    expect(
      dots(container).map((d) => d.dataset['previewCardDot']),
      'one configured slot means two live designs (the slot and the global ' +
        'fallback) and must therefore give the strip two pages',
    ).toEqual(['slot', 'fallback'])
    expect(
      container.querySelector('.cursor-grab'),
      'two pages with no drag affordance',
    ).not.toBeNull()
  })

  it('renders the slot artwork on its page and the GLOBAL artwork on the trailing page', () => {
    const { container } = renderPreview([OVERRIDE_SLOT])

    expect(container.querySelector('[data-preview-card-page]')).toHaveAttribute(
      'data-preview-card-page',
      'slot',
    )
    expect(gradientOf(container)).toContain('rgb(76, 29, 149)')

    fireEvent.click(restDot(container))

    expect(container.querySelector('[data-preview-card-page]')).toHaveAttribute(
      'data-preview-card-page',
      'fallback',
    )
    // The whole point of the page: the global design, not the slot's.
    expect(
      gradientOf(container),
      'the global page must render the GLOBAL gradient, not a copy of a slot',
    ).toContain('rgb(6, 78, 59)')
    expect(gradientOf(container)).not.toContain('rgb(76, 29, 149)')
  })

  it('names the trailing page for the subscriptions it covers, not by position', () => {
    const { container } = renderPreview([OVERRIDE_SLOT])
    const rest = en.brandingPage.sections.preview.cardPageRest

    const caption = () => container.querySelector('[data-preview-card-page-label]')
    expect(
      caption(),
      'the pages carry no visible name, so the operator cannot tell which ' +
        'subscriptions the page in front of them stands for',
    ).not.toBeNull()
    expect(caption()).toHaveTextContent('Card 1')

    fireEvent.click(restDot(container))

    expect(
      caption(),
      'the global page must be named for the subscriptions it covers',
    ).toHaveTextContent(rest)
    expect(caption()).toHaveAttribute('data-preview-card-page-label', 'fallback')
    expect(restDot(container)).toHaveAttribute('aria-label', rest)
    // "Card 2" would claim the page is a second slot the operator configured.
    expect(
      dots(container).map((d) => d.getAttribute('aria-label')),
    ).not.toContain('Card 2')
  })

  it('keeps exactly one live card renderer mounted on every page', () => {
    const { container, queryAllByTestId } = renderPreview([
      OVERRIDE_SLOT,
      { mode: 'inherit' as const, cardGradient: SECOND_SLOT_GRADIENT },
    ])

    expect(dots(container)).toHaveLength(3)
    for (let page = 0; page < 3; page += 1) {
      fireEvent.click(dots(container)[page]!)
      // WebKit gives a web-content process sixteen WebGL contexts and answers
      // the seventeenth by discarding the oldest unrecoverably. Adding pages
      // must not turn "one card on screen" into "one canvas per page".
      expect(
        container.querySelectorAll('[data-preview-subscription-card]'),
        'more than one page is mounted at once — every extra one is a live ' +
          'WebGL context',
      ).toHaveLength(1)
      expect(queryAllByTestId('preview-effect-renderer')).toHaveLength(1)
      expect(container.querySelectorAll('canvas')).toHaveLength(1)
    }
  })

  it('caps slot pages without ever dropping the global page', () => {
    const many = Array.from({ length: 9 }, () => ({ ...OVERRIDE_SLOT }))
    const { container } = renderPreview(many)

    // Six slot pages (the strip's cap) plus the global page, which describes
    // more subscriptions than any single slot and so is never the one cut.
    const roles = dots(container).map((d) => d.dataset['previewCardDot'])
    expect(
      roles,
      'the strip cap must bound SLOT pages; the global page is the one that ' +
        'describes most subscriptions and must survive it',
    ).toEqual(['slot', 'slot', 'slot', 'slot', 'slot', 'slot', 'fallback'])
  })
})

describe('preview card page copy', () => {
  it('ships the trailing page name in both languages', () => {
    expect(en.brandingPage.sections.preview.cardPageRest).toBeTruthy()
    expect(ru.brandingPage.sections.preview.cardPageRest).toBeTruthy()
    expect(ru.brandingPage.sections.preview.cardPageRest).not.toBe(
      en.brandingPage.sections.preview.cardPageRest,
    )
    // It must not read as another numbered card in either language.
    expect(en.brandingPage.sections.preview.cardPageRest).not.toContain('{{index}}')
    expect(ru.brandingPage.sections.preview.cardPageRest).not.toContain('{{index}}')
  })
})
