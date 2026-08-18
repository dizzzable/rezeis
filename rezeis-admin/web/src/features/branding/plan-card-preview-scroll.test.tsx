/**
 * What the "Тарифные карточки" live preview is a preview OF.
 *
 * The operator who reported this had five plans and saw three. The three that
 * showed were the three they had given a custom style, so the natural reading
 * was that the preview only draws CONFIGURED cards — and that reading, had it
 * been true, would have been a defensible design with a bad outcome, since a
 * plan left on its auto gradient is exactly the one whose look nobody has
 * checked and the subscriber sees that auto gradient too.
 *
 * It was not true. `TariffListPreview` was handed `plans.slice(0, 3)`: a
 * POSITIONAL cut with no relation to styling, and the correlation was the
 * operator's own doing — they had styled the plans they could see. The section
 * beside the preview lists every plan including archived ones (deliberately, see
 * `plan-card-styles-archived.test.tsx`) and both read the same unfiltered
 * `usePlans()`, so the preview was dropping plans its own settings list showed.
 *
 * Nothing in the cabinet justified the three. `/plans` is a plain vertical list
 * with no cap and no pagination, so these tests pin: every plan gets a card,
 * a plan with no style gets one too, and the list scrolls inside the phone
 * frame the way the subscriber's does.
 *
 * They also pin the bound that scrolling made necessary. Each animated card is
 * its own GPU context, WebKit allows sixteen per web-content process and hands
 * the seventeenth request's victim an unrecoverable loss, so an unbounded list
 * of renderers is the "cards go black one by one" failure the cabinet already
 * fought. The cabinet's answer is a six-slot budget; this is the same six, and
 * a preview that animated more than the cabinet grants would have stopped lying
 * about which plans exist only to start lying about how they move.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'

import { installIntersectionObserver, renderWithProviders } from '@/test/test-utils'

const previewPlans = vi.hoisted(() => ({ data: [] as unknown[] }))

vi.mock('@/features/plans/plans-api', () => ({
  usePlans: () => ({ data: previewPlans.data }),
}))

vi.mock('./card-effect-registry', async () => {
  const actual =
    await vi.importActual<typeof import('./card-effect-registry')>('./card-effect-registry')
  return {
    ...actual,
    CARD_EFFECT_COMPONENTS: {
      ...actual.CARD_EFFECT_COMPONENTS,
      // The real one would drive a WebGL context jsdom does not have.
      aurora: () => <canvas data-testid="preview-effect-renderer" />,
    },
  }
})

import { BrandingPreview } from './branding-preview'
import {
  CARD_EFFECT_PREVIEW_CONTEXT_BUDGET,
  createCardEffectPreviewBudget,
} from './card-effect-preview-budget'
import { isHiddenFromCabinetCatalog } from './plan-card-style-utils'

/**
 * The shape `/admin/plans` really returns, for the fields that decide anything
 * here. `isActive` and `isArchived` are required on that wire
 * (`admin-plan.interface.ts`), so a fixture that omits them would be testing a
 * plan the endpoint cannot produce — and would silently take the "hidden from
 * the catalogue" branch in every case below.
 */
const VISIBLE = { isActive: true, isArchived: false, availability: 'ALL' } as const

/** The reporter's catalogue: five plans, the first three styled. */
const REPORTED_PLANS = [
  { id: 'standard', name: 'Standard' },
  { id: 'minifamily', name: 'MiniFamily' },
  { id: 'oldmoney', name: 'OldMoney' },
  { id: 'starterpack', name: 'StarterPack' },
  { id: 'unlimited', name: 'Unlimited' },
].map((plan) => ({
  ...plan,
  ...VISIBLE,
  icon: 'sparkles',
  trafficLimit: 10,
  deviceLimit: 2,
}))

const STYLED = {
  standard: { gradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)' },
  minifamily: { gradient: 'linear-gradient(135deg, #4c1d95 0%, #a855f7 100%)' },
  oldmoney: { gradient: 'linear-gradient(135deg, #7f1d1d 0%, #ef4444 100%)' },
}

function auroraPlans(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `plan-${i}`,
    name: `Plan ${i}`,
    ...VISIBLE,
    icon: 'sparkles',
    trafficLimit: 10,
    deviceLimit: 2,
  }))
}

function auroraStyles(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `plan-${i}`,
      { cardEffect: 'aurora', cardEffectProps: {}, cardEffectOpacity: 1 },
    ]),
  )
}

function cards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-preview-tariff-card]')]
}

function renderers(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-preview-card-effect-renderer]'),
  ]
}

describe('tariff preview lists every plan', () => {
  afterEach(() => {
    previewPlans.data = []
  })

  it('renders a card for every plan, not the first three', () => {
    previewPlans.data = REPORTED_PLANS
    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{ planCardStyles: STYLED } as never} />,
    )

    expect(cards(container)).toHaveLength(REPORTED_PLANS.length)
    const names = [...container.querySelectorAll('[data-preview-tariff-card] p')]
      .map((node) => node.textContent)
    for (const plan of REPORTED_PLANS) {
      expect(names).toContain(plan.name)
    }
  })

  it('previews a plan that has no configured style', () => {
    // The two the reporter could not see. A missing entry in `planCardStyles`
    // means the auto gradient, which is a real appearance and not an absence,
    // so it has to be previewable — the whole point of looking is to find out
    // what an unstyled plan looks like.
    previewPlans.data = REPORTED_PLANS
    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{ planCardStyles: STYLED } as never} />,
    )

    const unstyled = cards(container).slice(3)
    expect(unstyled).toHaveLength(2)
    for (const card of unstyled) {
      expect(card.style.backgroundImage).toContain('linear-gradient')
    }
  })

  it('scrolls the list rather than growing past the phone frame', () => {
    previewPlans.data = auroraPlans(12)
    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{} as never} />,
    )

    const list = container.querySelector<HTMLElement>('[data-preview-tariff-list]')
    expect(list).not.toBeNull()
    expect(list).toHaveAttribute('data-preview-tariff-count', '12')
    // `flex-1` sizes the list to the space the frame has left and `min-h-0`
    // permits it to be smaller than its content; without the second, a flex
    // child grows to fit and `overflow-y-auto` never has anything to scroll.
    for (const token of ['overflow-y-auto', 'flex-1', 'min-h-0']) {
      expect(list?.className).toContain(token)
    }
    expect(cards(container)).toHaveLength(12)
  })
})

describe('live card effects are rationed like the cabinet rations them', () => {
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
    previewPlans.data = []
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('mounts no more renderers than the context budget, however many plans animate', () => {
    const total = CARD_EFFECT_PREVIEW_CONTEXT_BUDGET * 3
    previewPlans.data = auroraPlans(total)
    const viewport = installIntersectionObserver()

    const { container } = renderWithProviders(
      <BrandingPreview
        focus="planCards"
        values={{ planCardStyles: auroraStyles(total) } as never}
      />,
    )

    // Every plan is a card — the bound is on GPU contexts, never on the list.
    expect(cards(container)).toHaveLength(total)
    expect(renderers(container)).toHaveLength(CARD_EFFECT_PREVIEW_CONTEXT_BUDGET)

    // And the refused ones say so, rather than silently looking identical to a
    // plan the operator configured no effect for.
    const animated = cards(container).filter(
      (card) => card.dataset['previewTariffCardAnimated'] === 'true',
    )
    expect(animated).toHaveLength(CARD_EFFECT_PREVIEW_CONTEXT_BUDGET)

    viewport.restore()
  })

  it('draws nothing on a card that is off screen and hands its slot to one that is on', () => {
    const total = CARD_EFFECT_PREVIEW_CONTEXT_BUDGET * 2
    previewPlans.data = auroraPlans(total)
    const viewport = installIntersectionObserver()

    const { container } = renderWithProviders(
      <BrandingPreview
        focus="planCards"
        values={{ planCardStyles: auroraStyles(total) } as never}
      />,
    )

    const all = cards(container)
    const last = all[all.length - 1]!
    expect(last.dataset['previewTariffCardAnimated']).toBe('false')

    // Scroll so that only the last card is in view. The budget never revokes a
    // grant, so the slot has to come from the cards that left — which is the
    // whole reason the claim is tied to visibility rather than to mounting.
    act(() => {
      viewport.report((node) => node === last)
    })

    expect(last.dataset['previewTariffCardAnimated']).toBe('true')
    expect(renderers(container)).toHaveLength(1)

    viewport.restore()
  })

  it('leaves a card with no effect out of the budget entirely', () => {
    previewPlans.data = auroraPlans(3)
    const viewport = installIntersectionObserver()

    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{} as never} />,
    )

    expect(cards(container)).toHaveLength(3)
    expect(renderers(container)).toHaveLength(0)
    for (const card of cards(container)) {
      expect(card.dataset['previewTariffCardAnimated']).toBeUndefined()
    }

    viewport.restore()
  })
})

describe('plans the cabinet would not show are marked, not hidden', () => {
  afterEach(() => {
    previewPlans.data = []
  })

  /**
   * One case per clause of the cabinet's three-stage filter, plus the two ways
   * of getting the trial clause wrong. `trialFree` is emitted for EVERY plan and
   * defaults to true, so a check that forgot the `availability === 'TRIAL'`
   * conjunct would mark the whole catalogue; a check that forgot the default
   * would miss a trial plan whose settings JSON is the empty `{}` every plan
   * ships with.
   */
  const CASES = [
    { id: 'archived', marked: true, plan: { ...VISIBLE, isArchived: true } },
    { id: 'inactive', marked: true, plan: { ...VISIBLE, isActive: false } },
    {
      id: 'free-trial',
      marked: true,
      plan: { ...VISIBLE, availability: 'TRIAL', trialSettings: { free: true } },
    },
    {
      id: 'trial-default-settings',
      marked: true,
      plan: { ...VISIBLE, availability: 'TRIAL' },
    },
    {
      id: 'paid-trial',
      marked: false,
      plan: { ...VISIBLE, availability: 'TRIAL', trialSettings: { free: false } },
    },
    { id: 'plain', marked: false, plan: VISIBLE },
    // Availability the cabinet decides against a USER the panel does not have.
    // These plans are in the catalogue for the audience they target, so marking
    // them would be a louder lie than the one the marker fixes.
    { id: 'new-only', marked: false, plan: { ...VISIBLE, availability: 'NEW' } },
    { id: 'invited-only', marked: false, plan: { ...VISIBLE, availability: 'INVITED' } },
    { id: 'allowed-only', marked: false, plan: { ...VISIBLE, availability: 'ALLOWED' } },
  ] as const

  it.each(CASES)('marks $id: $marked', ({ id, marked, plan }) => {
    previewPlans.data = [
      { id, name: id, icon: 'sparkles', trafficLimit: 10, deviceLimit: 2, ...plan },
    ]
    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{} as never} />,
    )

    // Marked or not, the plan is always PRESENT — that is the whole settlement.
    expect(cards(container)).toHaveLength(1)
    expect(
      container.querySelectorAll('[data-preview-tariff-card-catalog-hidden]'),
    ).toHaveLength(marked ? 1 : 0)
  })

  it('marks only the plans the cabinet drops, in a mixed catalogue', () => {
    previewPlans.data = [
      { id: 'a', name: 'A', ...VISIBLE, icon: 'sparkles', trafficLimit: 1, deviceLimit: 1 },
      {
        id: 'b',
        name: 'B',
        ...VISIBLE,
        isArchived: true,
        icon: 'sparkles',
        trafficLimit: 1,
        deviceLimit: 1,
      },
      { id: 'c', name: 'C', ...VISIBLE, icon: 'sparkles', trafficLimit: 1, deviceLimit: 1 },
    ]
    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{} as never} />,
    )

    const items = [
      ...container.querySelectorAll<HTMLElement>('[data-preview-tariff-item]'),
    ]
    expect(items).toHaveLength(3)
    expect(
      items.map(
        (item) => item.querySelector('[data-preview-tariff-card-catalog-hidden]') !== null,
      ),
    ).toEqual([false, true, false])
  })

  it('does not touch the card the operator is judging', () => {
    // The marker must annotate, never restyle. A dimmed or tinted card would
    // make the operator pick colours against artwork no subscriber receives,
    // which is a worse lie than the one being fixed — so the card element of a
    // hidden plan has to be byte-identical to a shown one.
    const shared = { icon: 'sparkles', trafficLimit: 10, deviceLimit: 2 }
    const styles = {
      shown: { gradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)' },
      gone: { gradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)' },
    }
    previewPlans.data = [
      { id: 'shown', name: 'Shown', ...VISIBLE, ...shared },
      { id: 'gone', name: 'Gone', ...VISIBLE, isArchived: true, ...shared },
    ]
    const { container } = renderWithProviders(
      <BrandingPreview focus="planCards" values={{ planCardStyles: styles } as never} />,
    )

    const [shown, gone] = cards(container)
    expect(gone?.getAttribute('style')).toBe(shown?.getAttribute('style'))
    expect(gone?.className).toBe(shown?.className)
    expect(gone?.dataset['previewTariffCardForeground']).toBe(
      shown?.dataset['previewTariffCardForeground'],
    )
    // And the marker is genuinely outside the card, not a child of it.
    expect(gone?.querySelector('[data-preview-tariff-card-catalog-hidden]')).toBeNull()
    expect(
      container.querySelector('[data-preview-tariff-card-catalog-hidden]'),
    ).not.toBeNull()
  })
})

describe('isHiddenFromCabinetCatalog', () => {
  it('reads the derivation the catalogue mapper uses, not the panel idea of archived', () => {
    const base = { isActive: true, isArchived: false, availability: 'ALL' }
    expect(isHiddenFromCabinetCatalog(base)).toBe(false)
    expect(isHiddenFromCabinetCatalog({ ...base, isArchived: true })).toBe(true)
    expect(isHiddenFromCabinetCatalog({ ...base, isActive: false })).toBe(true)
    // `trialFree` is meaningless off a trial plan — the panel's equivalent must
    // keep the cabinet's conjunction or every paid plan reads as hidden.
    expect(
      isHiddenFromCabinetCatalog({ ...base, trialSettings: { free: true } }),
    ).toBe(false)
    expect(isHiddenFromCabinetCatalog({ ...base, availability: 'TRIAL' })).toBe(true)
    expect(
      isHiddenFromCabinetCatalog({
        ...base,
        availability: 'TRIAL',
        trialSettings: { free: false },
      }),
    ).toBe(false)
  })
})

describe('createCardEffectPreviewBudget', () => {
  it('grants the first claims, refuses the rest, and re-grants on release', () => {
    const budget = createCardEffectPreviewBudget(2)
    const answers: boolean[][] = [[], [], []]
    const release = [0, 1, 2].map((i) =>
      budget.claim((granted) => answers[i]!.push(granted)),
    )

    expect(budget.grantedCount).toBe(2)
    expect(answers[0]).toEqual([true])
    expect(answers[1]).toEqual([true])
    // Never told anything, because the answer never CHANGED from its initial
    // refusal — a listener that fired `false` on every settle would re-render
    // the whole tail of the list on every scroll frame.
    expect(answers[2]).toEqual([])

    release[0]!()
    expect(budget.grantedCount).toBe(2)
    expect(answers[2]).toEqual([true])

    // Releasing twice must not free a slot that was already freed.
    release[0]!()
    expect(budget.grantedCount).toBe(2)
  })
})
