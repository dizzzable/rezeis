import { fetchPlans } from '@/features/plans/plans-api'
import type { LandingCatalogPlan } from '../live/landing-kit-context'
import { PreviewLink } from './preview-link'

/**
 * Host bindings that let the vendored landing kit render inside the admin
 * preview. The kit is the production renderer; everything host-specific is
 * injected rather than re-implemented, which is what stops preview and prod
 * from drifting apart again.
 *
 * Two bindings, mirroring reiwa's in `landing-page.tsx`:
 *
 *  - `LinkComponent` — a CTA that looks live but stays put (see `PreviewLink`).
 *  - `loadPlans` — the real plan catalog. The admin IS the source of truth for
 *    plans, so catalog pricing shows actual data here. The old preview printed
 *    a placeholder, which meant the most commercially important section was the
 *    one the operator could never actually see.
 */

/** One major unit in minor units — the scale `formatMoney` divides back out. */
const MINOR_UNITS_PER_MAJOR = 100

/**
 * Cheapest active price across a plan's durations, in MINOR units.
 *
 * Two conversions happen here and BOTH used to be missing, which is why the
 * preview showed an empty price where the operator most needed a real one.
 *
 * 1. PARSE. `PlanDuration.prices[].price` arrives as a decimal STRING
 *    (`Decimal(20, 8)` put through `.toString()`), however the local wire type
 *    used to spell it. The old comparison was `<` between two of those
 *    strings, which is lexicographic: `'100' < '20'` is true, so the
 *    "cheapest" duration was whichever one sorted first as TEXT, and a plan
 *    priced 20 and 100 advertised 100. The two answers only differ when the
 *    prices differ in digit count, which is why it survived so long.
 *
 * 2. SCALE. The kit's field is `priceCents` and its `formatMoney` divides by
 *    100, but this catalog counts MAJOR units — `'199'` is 199 roubles, and
 *    the checkout is the thing that multiplies by 100 for gateways wanting
 *    minor units. Handing the parsed number straight through would render one
 *    hundredth of the real price, which is a wrong price rather than a missing
 *    one. `live/` is a byte-frozen vendored copy of reiwa's kit
 *    (`live-kit-manifest.test.ts`), so the scaling belongs HERE, in the host
 *    binding, and nowhere else.
 *
 * A price that does not parse is SKIPPED, never read as zero: "this plan is
 * free" and "this build cannot read this price" are different facts. A plan
 * whose every price is unreadable ends with no price at all, which the kit
 * already renders as a blank — its own fail-closed behaviour, reached
 * honestly instead of by a silent `0`.
 *
 * (Prices in different currencies are still compared against each other, as
 * they always were. That is a separate, pre-existing question — it needs a
 * display currency to answer — and nothing here makes it worse.)
 */
function lowestPriceCents(plan: {
  durations: ReadonlyArray<{
    isActive: boolean
    prices: ReadonlyArray<{ currency: string; price: string }>
  }>
}): { cents: number; currency: string } | null {
  let best: { cents: number; currency: string } | null = null
  for (const duration of plan.durations) {
    if (!duration.isActive) continue
    for (const price of duration.prices) {
      // `Number('')` and `Number('   ')` are both `0`, so an empty price would
      // otherwise arrive as free rather than as unreadable.
      const raw = price.price.trim()
      if (raw.length === 0) continue
      const major = Number(raw)
      if (!Number.isFinite(major)) continue
      const cents = Math.round(major * MINOR_UNITS_PER_MAJOR)
      if (best === null || cents < best.cents) {
        best = { cents, currency: price.currency }
      }
    }
  }
  return best
}

/**
 * Maps the admin catalog onto the kit's minimal plan shape. Inactive and
 * archived plans are dropped — the public landing never lists them, and the
 * preview exists to show what the public sees.
 */
export async function loadPreviewPlans(): Promise<readonly LandingCatalogPlan[]> {
  const plans = await fetchPlans()
  return plans
    .filter((plan) => plan.isActive && !plan.isArchived)
    .map((plan) => {
      const price = lowestPriceCents(plan)
      return {
        id: plan.id,
        name: plan.name,
        description: plan.description,
        priceCents: price?.cents,
        currency: price?.currency,
      }
    })
}

export const PREVIEW_KIT_BINDINGS = {
  LinkComponent: PreviewLink,
  loadPlans: loadPreviewPlans,
}
