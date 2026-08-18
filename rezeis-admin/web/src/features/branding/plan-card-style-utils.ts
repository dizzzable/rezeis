import { buildTextureCss, type TextureCss } from './app-texture'
import type {
  BrandingSubscriptionCardTextDraft,
  PlanCardStyleDraft,
} from './branding-form-schema'

/**
 * Deterministic auto gradient from a plan id. The Reiwa runtime uses the same
 * seed so unconfigured plan cards keep their look in the admin preview.
 */
export function autoPlanGradient(planId: string): string {
  let hash = 0
  for (let index = 0; index < planId.length; index += 1) {
    hash = (hash * 31 + planId.charCodeAt(index)) >>> 0
  }

  const hue = hash % 360
  return `linear-gradient(135deg, hsl(${hue} 70% 22%), hsl(${(hue + 40) % 360} 65% 32%))`
}

/**
 * The fields the catalogue decision reads. A structural subset of the admin
 * `Plan`, so `plans-api`'s type is assignable with no conversion — and so the
 * tests can state a case in four fields instead of twenty.
 */
export interface PlanCatalogVisibility {
  readonly isActive: boolean
  readonly isArchived: boolean
  readonly availability: string
  readonly trialSettings?: { readonly free: boolean } | undefined
}

/**
 * Whether the cabinet's buy catalogue hides this plan from EVERY subscriber.
 *
 * ── why this is not "isArchived" ────────────────────────────────────────────
 * The obvious version of this check — reading the panel's own idea of archived
 * — is wrong twice over, and both misses are silent. The cabinet's `/plans`
 * list is the product of three filters in three different places, and archived
 * is one clause of one of them:
 *
 *   1. SQL, always applied: `isActive: true, isArchived: false`
 *      (`rezeis-admin/src/modules/plans/services/plan-catalog.service.ts:55-69`)
 *   2. availability, evaluated in memory against the CALLER
 *      (same file, ~140-178)
 *   3. the cabinet's own last filter, `!(p.isTrial && p.trialFree)`
 *      (`reiwa/web/src/features/plans/plans-page.tsx:37`) — a FREE trial is
 *      claimed from the dashboard, never bought from the catalogue.
 *
 * So an inactive plan and a free-trial plan are both invisible to every
 * subscriber while being neither archived nor, in the free trial's case,
 * anything the panel's list would flag.
 *
 * ── why it cannot literally reuse the cabinet's expression ──────────────────
 * `isTrial` and `trialFree` do not exist on the admin wire. They are not
 * columns; they are DERIVED in the catalogue mapper for the cabinet's
 * projection alone (`plan-catalog.service.ts:206-207`):
 *
 *     isTrial:   plan.availability === PlanAvailability.TRIAL
 *     trialFree: readTrialSettings(plan.trialSettings).free
 *
 * The admin endpoint runs a different mapper over the same table and emits
 * `availability` + `trialSettings` instead. Reusing the cabinet's LOGIC
 * therefore means reusing that derivation, which is what the last clause below
 * is — not calling the cabinet's field names, which the panel never receives.
 *
 * `readTrialSettings` defaults `free` to TRUE for the empty `{}` every plan
 * carries by default (`utils/trial-settings.util.ts:37-42`), so `?? true`
 * matches the backend rather than guessing. The `availability === 'TRIAL'`
 * conjunct is load-bearing for the same reason the cabinet writes it as a
 * conjunction: `trialFree` reads true for ordinary paid plans too, and testing
 * it alone would mark the entire catalogue hidden.
 *
 * ── what this deliberately does NOT claim ───────────────────────────────────
 * Filter 2 is undecidable here and must stay that way. `NEW`, `EXISTING`,
 * `INVITED` and `ALLOWED` are answered against a user the panel does not have,
 * and a paid `TRIAL` additionally depends on that user's claim count. Those
 * plans ARE in the catalogue for the audience they target, so marking them
 * would be a louder lie than the one this fixes. Only the three
 * subscriber-independent cases are reported.
 */
export function isHiddenFromCabinetCatalog(plan: PlanCatalogVisibility): boolean {
  if (!plan.isActive || plan.isArchived) return true
  return plan.availability === 'TRIAL' && (plan.trialSettings?.free ?? true)
}

/** Builds the optional static texture layer for compact tariff-card previews. */
export function resolvePlanCardTextureCss(style: PlanCardStyleDraft | undefined): TextureCss | null {
  if (style?.textureUrl || !style?.texturePreset) return null

  return buildTextureCss({
    pattern: style.texturePreset,
    color: isHex(style.accent) ? style.accent : '#ffffff',
    background: 'transparent',
    scale: 16,
    opacity: 0.5,
  })
}

/**
 * The effective text policy for one tariff card, as the cabinet resolves it.
 *
 * PRECEDENCE, and it is the same one the positional card slots use: an explicit
 * per-plan override wins; anything else — an absent `text`, an explicit
 * `inherit`, a value a newer panel wrote and this bundle does not recognise, or
 * a `custom` with no usable colour — falls back to the global
 * `subscriptionCardText`. Its own default is `auto`, which is how an
 * installation that has never touched either control keeps the automatic
 * contrast computation it has today.
 *
 * Mirrors reiwa `resolvePlanCardText`. The two are separate implementations in
 * separate repositories, so `plan-card-styles-round-trip.test.ts` drives both
 * from the same inputs; if this drifts, the operator is shown a colour the
 * subscriber will not see, which is worse than showing nothing.
 */
export function resolvePlanCardText(
  style: PlanCardStyleDraft | undefined,
  subscriptionCardText: BrandingSubscriptionCardTextDraft,
): BrandingSubscriptionCardTextDraft {
  const text = style?.text
  if (!text || text.mode === 'inherit') return subscriptionCardText
  if (text.mode === 'auto' || text.mode === 'light' || text.mode === 'dark') {
    return { mode: text.mode, color: null }
  }
  if (text.mode === 'custom' && isOpaqueHex(text.color)) {
    return { mode: 'custom', color: text.color }
  }
  return subscriptionCardText
}

/**
 * The literal foreground an operator decision forces, or `null` when the card
 * computes its own contrast (`auto`). Mirrors reiwa `resolveCardTextForeground`
 * — including the exact hex pair, which is what makes the preview and the
 * cabinet agree pixel-for-pixel.
 */
export function resolveCardTextForeground(
  text: BrandingSubscriptionCardTextDraft,
): string | null {
  if (text.mode === 'light') return '#ffffff'
  if (text.mode === 'dark') return '#0a0a0a'
  return text.mode === 'custom' && isOpaqueHex(text.color) ? text.color : null
}

function isOpaqueHex(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim())
}

function isHex(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(value.trim())
}
