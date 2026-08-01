import { buildTextureCss, type TextureCss } from './app-texture'
import type { PlanCardStyleDraft } from './branding-form-schema'

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

function isHex(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(value.trim())
}
