/**
 * THE PRICE THE OPERATOR COULD NEVER SEE.
 *
 * `loadPlans` exists so the builder preview shows the REAL catalog: the comment
 * on the binding says it was added because the old preview printed a
 * placeholder, leaving "the most commercially important section" invisible.
 * The placeholder was then replaced by nothing at all, through two faults that
 * only a truthful wire type could surface.
 *
 *  1. `PlanDuration.prices[].price` arrives as a decimal STRING (a Prisma
 *     `Decimal(20, 8)` through `.toString()`), while the SPA declared `number`.
 *     The cheapest-price search compared two of those strings with `<`, which
 *     is LEXICOGRAPHIC: `'100' < '20'` is true, so the "cheapest" duration was
 *     whichever sorted first as text. The string then reached the kit, whose
 *     `formatMoney` starts `if (typeof cents !== 'number') return ''` — an
 *     empty price cell.
 *  2. The kit's field is `priceCents` and it divides by 100, but this catalog
 *     counts MAJOR units. A number handed straight through renders one
 *     hundredth of the real price, which is worse than blank: it is wrong and
 *     it looks right.
 *
 * `live/` is a byte-frozen vendored copy of reiwa's kit
 * (`live-kit-manifest.test.ts`), so both conversions belong to the host
 * binding. These cases therefore assert the binding's OUTPUT and the SECTION's
 * rendered text — never that two implementations of the same arithmetic agree.
 *
 * THE FIXTURE IS BUILT TO DISCRIMINATE. Its two prices are `'100'` and `'20'`,
 * which text order and numeric order rank differently, and every case states
 * the expected answer outright rather than deriving it.
 */
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import type { Plan, PlanDuration } from '@/features/plans/plans-api'
import { renderWithProviders } from '@/test/test-utils'
import { LandingKitProvider } from '../live/landing-kit-context'
import type { LandingSection } from '../live/landing-schema'
import PricingSection from '../live/sections/pricing'
import { PREVIEW_KIT_BINDINGS, loadPreviewPlans } from './preview-kit-bindings'

function duration(
  id: string,
  days: number,
  isActive: boolean,
  prices: ReadonlyArray<{ readonly currency: string; readonly price: string }>,
): PlanDuration {
  return {
    id,
    days,
    isActive,
    prices: prices.map((price, index) => ({ id: `${id}-p${index}`, ...price })),
  }
}

function planWith(durations: ReadonlyArray<PlanDuration>): Plan {
  return {
    id: 'plan-1',
    name: 'Premium',
    description: null,
    tag: null,
    icon: null,
    type: 'TRAFFIC',
    availability: 'ALL',
    trafficLimit: 50,
    deviceLimit: 1,
    trafficLimitStrategy: 'MONTH',
    isActive: true,
    isArchived: false,
    orderIndex: 1,
    internalSquads: [],
    externalSquad: null,
    durations,
    replacementPlanIds: [],
    upgradeToPlanIds: [],
  }
}

/**
 * The discriminating pair: a year at 20 and a month at 100. As TEXT `'100'`
 * sorts BELOW `'20'`, so the two orderings disagree about which is cheapest —
 * which is the only reason this fixture is worth anything.
 */
const DISCRIMINATING_PLAN = planWith([
  duration('d-month', 30, true, [{ currency: 'RUB', price: '100' }]),
  duration('d-year', 365, true, [{ currency: 'RUB', price: '20' }]),
])

function servePlans(plans: readonly Plan[]): void {
  vi.spyOn(api, 'get').mockImplementation((async (path: string) => {
    if (path === '/admin/plans') return { data: plans }
    return { data: [] }
  }) as never)
}

const CATALOG_PRICING: LandingSection = {
  id: 'section-pricing',
  type: 'pricing',
  visible: true,
  data: { source: 'catalog', heading: { ru: 'Тарифы' } },
}

describe('the builder preview binds the real catalog price', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('picks the numerically lowest duration price, not the one that sorts first as text', async () => {
    // Stated first, and stated outright: 20 is the cheaper price, so 2000
    // minor units is the answer. A `<` between the raw strings answers 100.
    servePlans([DISCRIMINATING_PLAN])

    const [previewed] = await loadPreviewPlans()

    expect(previewed.priceCents).toBe(2000)
    // Why the fixture separates the two orderings at all.
    expect('100' < '20').toBe(true)
  })

  it('carries the currency of the price it actually chose', async () => {
    servePlans([
      planWith([
        duration('d-month', 30, true, [{ currency: 'USD', price: '100' }]),
        duration('d-year', 365, true, [{ currency: 'RUB', price: '20' }]),
      ]),
    ])

    const [previewed] = await loadPreviewPlans()

    expect(previewed.priceCents).toBe(2000)
    expect(previewed.currency).toBe('RUB')
  })

  it('never lets an inactive duration set the advertised price', async () => {
    servePlans([
      planWith([
        duration('d-retired', 365, false, [{ currency: 'RUB', price: '1' }]),
        duration('d-month', 30, true, [{ currency: 'RUB', price: '20' }]),
      ]),
    ])

    // The retired duration is the cheapest number in the payload and must not
    // win: the public landing may only advertise a price a visitor can buy.
    expect((await loadPreviewPlans())[0].priceCents).toBe(2000)
  })

  it('skips a price it cannot read rather than reading it as free', async () => {
    servePlans([
      planWith([
        duration('d-broken', 30, true, [{ currency: 'RUB', price: 'not-a-number' }]),
        duration('d-year', 365, true, [{ currency: 'RUB', price: '20' }]),
      ]),
    ])

    // Zero would win every comparison and advertise the plan as free.
    expect((await loadPreviewPlans())[0].priceCents).toBe(2000)
  })

  it('leaves a plan with no readable price without one, instead of at zero', async () => {
    // `Number('')` is `0`, so an empty price becomes "free" the moment anyone
    // parses without checking. "This plan costs nothing" and "this build
    // cannot read this plan's price" are different facts.
    servePlans([planWith([duration('d-month', 30, true, [{ currency: 'RUB', price: '' }])])])

    expect((await loadPreviewPlans())[0].priceCents).toBeUndefined()
  })

  it('renders a real price in the pricing section instead of an empty cell', async () => {
    servePlans([DISCRIMINATING_PLAN])

    renderWithProviders(
      <LandingKitProvider value={PREVIEW_KIT_BINDINGS}>
        <PricingSection section={CATALOG_PRICING} locale="ru" defaultLocale="ru" />
      </LandingKitProvider>,
    )

    // The section rendered at all — without this, "the price is not 100"
    // passes on a section that fail-closed and drew nothing.
    const card = await screen.findByRole('listitem')
    const price = card.querySelector('p.text-3xl')
    expect(price, 'the plan card carries no price element').not.toBeNull()
    const rendered = (price as HTMLElement).textContent?.trim() ?? ''

    // THE DEFECT: a string reached `formatMoney`, which returns '' for
    // anything that is not a number, so this cell was blank.
    expect(rendered).not.toBe('')
    // 20 units of currency — the cheaper duration, scaled back out of the minor
    // units the kit divides by.
    expect(rendered).toMatch(/(^|\D)20(\D|$)/)
    // Not the text-order pick…
    expect(rendered).not.toMatch(/(^|\D)100(\D|$)/)
    // …and not the unscaled one, which rounds 0.2 down to a free plan.
    expect(rendered).not.toMatch(/(^|\D)0(\D|$)/)
  })
})
