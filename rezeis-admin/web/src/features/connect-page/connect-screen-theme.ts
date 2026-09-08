/**
 * connect-screen-theme
 * ────────────────────
 * Turning one of the 104 concepts into the small payload the cabinet's connect
 * screen can wear.
 *
 * ── Why the panel resolves this and not the cabinet ──────────────────────────
 *
 * The concept book lives here. The cabinet receives resolved values and has no
 * catalogue of its own — the same arrangement branding already uses, and for the
 * same reason: shipping the book to every customer's browser would send 104
 * palettes to render one.
 *
 * ── Why so few tokens ────────────────────────────────────────────────────────
 *
 * A concept resolves to the full shadcn set, thirty-odd values. The connect
 * screen reads twelve. Sending the rest would be sending properties nothing
 * renders — an operator would see their choice do nothing on some of them and
 * have no way to tell that from the feature being broken. So the mapping below
 * is explicit and one-directional, and `connect-page.theme.ts` on the server
 * refuses anything outside it.
 *
 * ── One brightness, not two ──────────────────────────────────────────────────
 *
 * Branding ships a light and a dark rendering of the chosen concept because the
 * cabinet lets a customer pick. This screen ships ONE: the brightness the
 * concept was drawn at. A concept is a whole look — Midnight Coral Mesh is a
 * dark thing and Alpine Moss Glass is a light one — and an operator dressing
 * this screen deliberately is choosing that look, not a palette to be re-lit.
 * The cost is that a light-mode cabinet can open a dark connect screen; that is
 * the operator's decision to make, and it is visible in the preview.
 */
import {
  CONCEPT_PRESETS,
  getConceptSourceMode,
  getConceptThemeModeVisual,
  type ConceptPresetDescriptor,
} from '../../lib/theme/concept-presets'

/** The payload shape `connect-page.theme.ts` validates and the cabinet reads. */
export interface ConnectScreenThemePayload {
  readonly presetId: string
  readonly tokens: Readonly<Record<string, string>>
  readonly backgroundColor: string
  readonly backgroundImage: string
  readonly rail: string
}

/**
 * Which resolved value answers each of the screen's tokens.
 *
 * `color-surface-high` is the RAISED surface — the fact tiles, the workspace,
 * the link card. The SUNKEN one is not in this table because the generator does
 * not have it: `card`, `popover` and `muted` resolve to the SAME value in all
 * 104 concepts, and `secondary` in 47 of them. See `sunkenSurface` below.
 */
const TOKEN_SOURCE: Readonly<Record<string, string>> = {
  'brand-primary': 'primary',
  'brand-primary-fg': 'primary-foreground',
  'brand-foreground': 'foreground',
  'brand-muted-foreground': 'muted-foreground',
  'color-surface-high': 'card',
}

/** `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` all the way to three channels. */
function channels(hex: string): readonly [number, number, number] | null {
  const body = hex.replace('#', '')
  const wide = body.length >= 6
  const size = wide ? 2 : 1
  if (body.length !== (wide ? 6 : 3) && body.length !== (wide ? 8 : 4)) return null
  const read = (index: number): number => {
    const slice = body.slice(index * size, index * size + size)
    const value = Number.parseInt(wide ? slice : slice + slice, 16)
    return Number.isNaN(value) ? -1 : value
  }
  const rgb = [read(0), read(1), read(2)] as const
  return rgb.some((value) => value < 0) ? null : rgb
}

function mix(from: string, to: string, ratio: number): string | null {
  const a = channels(from)
  const b = channels(to)
  if (a === null || b === null) return null
  const channel = (index: 0 | 1 | 2): string =>
    Math.round(a[index] + (b[index] - a[index]) * ratio)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

/**
 * The surface the chips, the buttons and the step timeline sit on.
 *
 * Derived rather than read, because the resolved palette does not contain it:
 * `card`, `popover` and `muted` are one value in every concept in the book. The
 * concepts themselves plainly have two — Midnight Coral Mesh fills its
 * workspace with `#151224` and its timeline with `#0D0B17` over a `#05070D`
 * page — and losing that difference is what makes the timeline read as a hole
 * punched in the card it sits inside, which is the flatness this redesign was
 * reported for in the first place.
 *
 * Halfway between the page and the card is where the concepts put it. The
 * fallback matters for the one concept whose card IS its background: there is
 * nothing to interpolate, so the sunken surface is lifted a little toward the
 * text instead. A small honest separation beats two identical surfaces.
 */
function sunkenSurface(background: string, card: string, foreground: string): string {
  const between = mix(background, card, 0.5)
  if (between !== null && between.toLowerCase() !== card.toLowerCase()) return between
  return mix(card, foreground, 0.08) ?? card
}

/**
 * The hairline — the tile border, the header rule, the step dividers and the
 * chip outlines, which every concept draws with ONE value.
 *
 * NOT the resolved `border` token, and that is the whole point of this
 * function. `border` is built with `ensureContrast(…, 3.1)` because shadcn
 * chrome needs borders you can see: it comes out of Midnight Coral Mesh as an
 * opaque `#6F5A63`, where the concept itself draws `#FF8AA83D` — the accent,
 * lightened, at 24% alpha. On a screen made almost entirely of bordered
 * surfaces that difference is not subtle; it is the difference between a card
 * that floats and a card that is outlined.
 *
 * So it is rebuilt the way the concepts build it. The contrast rule is not
 * being ignored — it is being applied to the right thing: these are decorative
 * separators between surfaces, not the boundary of a control, and the controls
 * on this screen carry their own fill.
 */
function hairline(primary: string, foreground: string, alpha: number): string {
  const lightened = mix(primary, foreground, 0.2) ?? primary
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0')
  return `${lightened}${byte}`
}

export function conceptById(presetId: string): ConceptPresetDescriptor | null {
  return CONCEPT_PRESETS.find((preset) => preset.id === presetId) ?? null
}

/**
 * Build what gets stored, or `null` when the id names no concept.
 *
 * `null` rather than a throw: the id reaches this from a stored row, and a
 * concept retired between two panel releases must degrade to "the cabinet's own
 * appearance" rather than take the editor down.
 */
export function buildConnectScreenTheme(presetId: string): ConnectScreenThemePayload | null {
  const descriptor = conceptById(presetId)
  if (descriptor === null) return null

  const mode = getConceptSourceMode(descriptor)
  const visual = getConceptThemeModeVisual(descriptor, mode)
  const values = visual.tokens as unknown as Record<string, string>

  const tokens: Record<string, string> = {}
  for (const [target, source] of Object.entries(TOKEN_SOURCE)) {
    const value = values[source]
    if (typeof value === 'string' && value.length > 0) tokens[target] = value
  }

  const primary = values['primary'] ?? values['foreground'] ?? '#000000'
  const foreground = values['foreground'] ?? '#ffffff'
  tokens['color-surface'] = sunkenSurface(
    values['background'] ?? '#000000',
    values['card'] ?? values['background'] ?? '#000000',
    foreground,
  )
  // 24% and 40%: the two weights the concepts alternate between for a divider
  // and an outline.
  tokens['color-border-soft'] = hairline(primary, foreground, 0.24)
  tokens['color-border-strong'] = hairline(primary, foreground, 0.4)

  // Radii travel because they are half of what separates a concept from a
  // palette: `surfaceRadius` is the 22px the cards are actually drawn with, and
  // `canonicalRadius` the smaller one the controls use. `radius-pill` is left
  // alone deliberately — a pill is a pill in every concept, and overriding it
  // would reshape every button on the screen to match a card.
  tokens['radius-card'] = `${descriptor.classification.surfaceRadius}px`
  tokens['radius-item'] = `${descriptor.classification.canonicalRadius}px`
  tokens['glass-blur'] = descriptor.classification.backgroundBlur ? '26px' : '0px'

  return {
    presetId: descriptor.id,
    tokens,
    backgroundColor: values['background'] ?? '#000000',
    backgroundImage: visual.backgroundImage,
    // Every concept in the book runs a 4px rail down the left edge in its
    // accent. It is the cheapest half of their identity and the first thing
    // missing from a screen that is "almost" the concept.
    rail: values['primary'] ?? values['foreground'] ?? '#000000',
  }
}
