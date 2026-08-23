/**
 * `null GB` — WHAT EVERY DEVICES AND UNLIMITED PLAN USED TO SAY.
 *
 * `/admin/plans` states a plan's traffic cap in three ways and the list page
 * read two of them:
 *
 *   `null`      UNLIMITED. `plans-admin.normalizers` WRITES it for every
 *               DEVICES and every UNLIMITED plan, so it is the ordinary case
 *               for exactly the plans whose point is that they are uncapped.
 *   `0`         a cap of ZERO gigabytes — no traffic at all. The opposite
 *               product fact, still held by rows authored before the DTO was
 *               raised to `@Min(1)`.
 *   a number    that many whole gigabytes.
 *
 * The unlimited branch tested `gb === 0`, which `null` never satisfies. So the
 * branch was unreachable for the two plan types that ARE unlimited, the
 * template literal ran instead, and the card printed the literal text
 * `null GB`. The SPA wire type declared `number`, so tsc could not say a word
 * about it while the server had declared `number | null` all along.
 *
 * These cases drive the REAL page through the REAL fetcher and read the stat
 * the operator reads. Each asserts the EXACT rendered string, which excludes
 * both plausible wrong answers at once: `null GB` (the defect) and `0 GB`
 * (what `?? 0` puts there — unlimited silently turned into its opposite).
 *
 * ANTI-VACUITY. Every case renders all three plans in ONE pass, proves each
 * card and its traffic stat exist before reading them, and compares the three
 * states against one another in that same render. "The unlimited card does not
 * say null" therefore cannot pass because the page rendered nothing, failed to
 * fetch, or listed one plan.
 */
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import PlansPage from './plans-page'
import type { Plan } from './plans-api'

/** Read from the ACTIVE bundle rather than re-typed, so a copy edit cannot lie. */
const unlimitedLabel = (): string => i18n.t('plansPage.unlimited')

function plan(overrides: Partial<Plan> & { readonly id: string; readonly name: string }): Plan {
  return {
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
    durations: [],
    replacementPlanIds: [],
    upgradeToPlanIds: [],
    ...overrides,
  }
}

/**
 * The three states, side by side, differing in `trafficLimit` and the plan
 * `type` that produces it. The two `null` rows are what the server actually
 * sends for these types — not a hypothetical.
 */
const PLANS: readonly Plan[] = [
  plan({ id: 'plan-devices', name: 'Five Devices', type: 'DEVICES', trafficLimit: null, deviceLimit: 5, orderIndex: 1 }),
  plan({ id: 'plan-unlimited', name: 'Boundless', type: 'UNLIMITED', trafficLimit: null, deviceLimit: -1, orderIndex: 2 }),
  plan({ id: 'plan-traffic', name: 'Fifty Gigabytes', type: 'TRAFFIC', trafficLimit: 50, deviceLimit: -1, orderIndex: 3 }),
]

async function renderPlansPage(): Promise<void> {
  vi.spyOn(api, 'get').mockImplementation((async (path: string) => {
    if (path === '/admin/plans') return { data: PLANS }
    return { data: [] }
  }) as never)

  renderWithProviders(<PlansPage />)

  // The page must have listed EVERY plan before any card is read. Without
  // this, a case asserting "the unlimited card does not say null" would pass
  // on a page that rendered no cards at all.
  for (const listed of PLANS) {
    expect(await screen.findByTitle(listed.name)).toBeInTheDocument()
  }
}

/**
 * The traffic stat, exactly as rendered, for the card carrying `name`.
 *
 * Walks UP from that plan's own title element to the nearest ancestor holding
 * a traffic stat, so the value returned can only be that plan's, and never
 * matches on a CSS class — classes are styling, not contract.
 */
function trafficValueFor(name: string): string {
  const label = i18n.t('plansPage.labels.traffic')
  const statIn = (root: HTMLElement): HTMLSpanElement | undefined =>
    Array.from(root.querySelectorAll('span')).find(
      (span) => (span.textContent ?? '').startsWith(label) && span.querySelector('span') !== null,
    )

  let node: HTMLElement | null = screen.getByTitle(name)
  for (; node !== null; node = node.parentElement) {
    const stat = statIn(node)
    if (stat === undefined) continue
    const value = stat.querySelector('span')
    expect(value, `the traffic stat for ${name} carries no value`).not.toBeNull()
    return (value as HTMLSpanElement).textContent?.trim() ?? ''
  }
  throw new Error(`no traffic stat on the card for ${name}`)
}

describe('the plans list states a traffic cap in three ways', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('says unlimited for a DEVICES plan, whose cap the server stores as null', async () => {
    await renderPlansPage()

    const rendered = trafficValueFor('Five Devices')
    expect(rendered).toBe(unlimitedLabel())
    // THE REGRESSION THIS FILE EXISTS FOR.
    expect(rendered).not.toContain('null')
    // AND its inversion: `?? 0` reaches `0 GB`, which is a cap of no traffic
    // at all — the opposite of what this plan is.
    expect(rendered).not.toContain('GB')
  })

  it('says unlimited for an UNLIMITED plan, whose cap the server also stores as null', async () => {
    await renderPlansPage()

    const rendered = trafficValueFor('Boundless')
    expect(rendered).toBe(unlimitedLabel())
    expect(rendered).not.toContain('null')
    expect(rendered).not.toContain('GB')
  })

  it('prints the number a TRAFFIC plan actually carries', async () => {
    await renderPlansPage()

    expect(trafficValueFor('Fifty Gigabytes')).toBe('50 GB')
  })

  it('does not render a capped plan the way it renders an uncapped one', async () => {
    await renderPlansPage()

    // Asserted in ONE render, so this cannot pass on a page that showed a
    // single card: the two answers must differ, and each must be the right one.
    expect(trafficValueFor('Boundless')).toBe(unlimitedLabel())
    expect(trafficValueFor('Fifty Gigabytes')).toBe('50 GB')
    expect(trafficValueFor('Boundless')).not.toBe(trafficValueFor('Fifty Gigabytes'))
  })
})
