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
