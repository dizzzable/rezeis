/**
 * The colours of the analytics charts — the panel's own palette, given jobs.
 *
 * CATEGORICAL: `SURFACE_HUES` from `surface-palette.ts`, the five hues the usage
 * rings already use, searched and measured there to stay apart from each other
 * and from every status colour. Re-measured for this page with the dataviz
 * validator (Machado 2009 CVD simulation, OKLab ΔE×100), all pairs, not just
 * neighbours — a colour here is keyed to its category, so any two of them can
 * end up side by side in a stack:
 *
 *   light card #ffffff: worst pair ΔE 16.0 as seen, 8.6 under deuteranopia;
 *     the sky and the pink sit under 3:1 against white (2.31, 2.53), so every
 *     chart that uses them also names its series in a legend and has a table;
 *   dark card #171717: the same separation, every hue above 3:1. The sky, the
 *     lavender and the pink sit above the 0.67 lightness a dark-only palette
 *     would choose; stepping them down into that band was measured too, and it
 *     drops the worst pair to 14.4 — under the hard floor of 15. Kept, as the
 *     surface palette keeps it.
 *
 * KEYED BY WHAT IS DRAWN, NEVER BY RANK. RUB is blue in every chart of the page
 * and stays blue when USDT overtakes it; a renewal is sky wherever renewals are.
 *
 * ORDINAL (the funnel's steps) and SEQUENTIAL (the cohort heatmap) are one hue —
 * the blue — mixed toward an anchor with `color-mix`, so they follow the theme
 * the operator runs, not a fixed white or black. Mixed IN OKLAB, never oklch:
 * the theme writes its card as `oklch(1 0 0)`, an explicit hue of 0°, not a
 * missing one, so an oklch mix swings the blue's 258° round through 300° and
 * the lighter steps came out lavender (seen in the browser). Oklab is
 * rectangular: the mix walks straight toward the anchor and keeps the hue.
 *
 *   funnel, light: toward the card — #0b66d6 → #8bb3ef, every step ΔL ≥ 0.06,
 *     the palest 2.14:1 on white;
 *   funnel, dark: toward the text colour — the palest step on a dark card is the
 *     blue itself, 3.32:1 (toward the dark card the steps collapse: 1.71:1);
 *   heatmap: toward the card in both themes, capped at 80 % so the cell's text
 *     in the theme's own foreground stays above 5:1 in either.
 */
import { SURFACE_HUES, SURFACE_OTHER_COLOR, SURFACE_UNKNOWN_COLOR } from './surface-palette'
import type { PurchaseKind } from './analytics-api'

/** Every single-series chart, and the current period. */
export const ACCENT = SURFACE_HUES.blue

/** The previous period, and "everything else": the dashboard's neutral. */
export const GHOST = SURFACE_OTHER_COLOR

/** A currency the palette names; the rest fold into «Другие» in grey. */
const CURRENCY_COLORS: Readonly<Record<string, string>> = {
  RUB: SURFACE_HUES.blue,
  USDT: SURFACE_HUES.sky,
  USD: SURFACE_HUES.lavender,
  XTR: SURFACE_HUES.pink,
  TON: SURFACE_HUES.plum,
}

/** The order currencies stack in: fixed, so a bar never reshuffles between periods. */
export const CURRENCY_ORDER: readonly string[] = Object.keys(CURRENCY_COLORS)

export const OTHER_COLOR = SURFACE_OTHER_COLOR

export function currencyColor(currency: string): string {
  return Object.hasOwn(CURRENCY_COLORS, currency) ? (CURRENCY_COLORS[currency] as string) : OTHER_COLOR
}

/** What a payment bought, in the order the stacks are drawn (and the legend reads). */
export const PURCHASE_KIND_COLORS: Readonly<Record<PurchaseKind, string>> = {
  new: SURFACE_HUES.blue,
  renewal: SURFACE_HUES.sky,
  change: SURFACE_HUES.plum,
  addon: SURFACE_HUES.pink,
}

/**
 * The subscriptions ending soon. The one that needs the operator — paid, and
 * nothing will be charged — takes the strongest hue.
 */
export const EXPIRING_COLORS = {
  manual: SURFACE_HUES.blue,
  autopay: SURFACE_HUES.sky,
  trial: SURFACE_HUES.lavender,
} as const

/**
 * Outcomes of a payment attempt: these ARE statuses, so they wear status
 * colours — green for paid, the theme's `--destructive` for failed — and a
 * neutral for canceled, which is a customer changing their mind, not a fault.
 * Each is named in the legend and the tooltip, never by colour alone.
 *
 * DRAWN paid | canceled | failed, so the grey always stands between green and
 * red: side by side those two measure ΔE 5.2–5.8 under protanopia and
 * deuteranopia, below the floor of 6. With the grey between them and this
 * darker green: light 11.3 worst pair; dark 6.1 (red↔grey) — the warn band,
 * carried by the 2 px gaps between segments, the legend and the numbers.
 */
export const OUTCOME_COLORS = {
  paid: 'oklch(0.52 0.14 150)',
  failed: 'var(--destructive)',
  canceled: SURFACE_OTHER_COLOR,
  pending: SURFACE_UNKNOWN_COLOR,
} as const

/**
 * Sets the funnel's anchor on the page root: the card in the light theme, the
 * text colour in the dark one (see the note at the top).
 */
export const RAMP_ANCHOR_CLASS = '[--analytics-ramp-anchor:var(--card)] dark:[--analytics-ramp-anchor:var(--foreground)]'

/** The shares of the accent in the funnel's four steps — measured, see the note at the top. */
const FUNNEL_STEPS = [100, 83, 67, 51] as const

export function funnelColor(step: number): string {
  const share = FUNNEL_STEPS[Math.min(step, FUNNEL_STEPS.length - 1)] as number
  return share === 100 ? ACCENT : `color-mix(in oklab, ${ACCENT} ${share}%, var(--analytics-ramp-anchor, var(--card)))`
}

/** The heatmap's strongest cell: the accent at 80 % over the card. */
export const HEAT_MAX_SHARE = 0.8
/** Its faintest non-zero cell, still visibly a tint. */
export const HEAT_MIN_SHARE = 0.08

/**
 * A heatmap cell's background for a value at `intensity` (0–1 of the table's
 * largest value). Zero is the card itself.
 */
export function heatColor(intensity: number): string {
  if (!(intensity > 0)) return 'transparent'
  const share = HEAT_MIN_SHARE + (HEAT_MAX_SHARE - HEAT_MIN_SHARE) * Math.min(1, intensity)
  return `color-mix(in oklab, ${ACCENT} ${Math.round(share * 100)}%, var(--card))`
}
