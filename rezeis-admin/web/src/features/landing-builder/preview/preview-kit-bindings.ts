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

/** Cheapest active price across a plan's durations, in minor units. */
function lowestPriceCents(plan: {
  durations: ReadonlyArray<{
    isActive: boolean
    prices: ReadonlyArray<{ currency: string; price: number }>
  }>
}): { cents: number; currency: string } | null {
  let best: { cents: number; currency: string } | null = null
  for (const duration of plan.durations) {
    if (!duration.isActive) continue
    for (const price of duration.prices) {
      if (best === null || price.price < best.cents) {
        best = { cents: price.price, currency: price.currency }
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
