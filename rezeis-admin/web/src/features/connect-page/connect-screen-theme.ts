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
 * 104 concepts, and `secondary` in 47 of them. See `connectSurfaces` below,
 * which derives both of them from what the card actually RENDERS as.
 */
const TOKEN_SOURCE: Readonly<Record<string, string>> = {
  'brand-primary': 'primary',
  'brand-primary-fg': 'primary-foreground',
  'brand-foreground': 'foreground',
  'brand-muted-foreground': 'muted-foreground',
  'color-surface-high': 'card',
}

/** `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` to three channels plus alpha. */
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

/** The alpha a colour carries, as 0…1. Absent means opaque. */
function alphaOf(hex: string): number {
  const body = hex.replace('#', '')
  if (body.length === 8) return Number.parseInt(body.slice(6, 8), 16) / 255
  if (body.length === 4) {
    const digit = body.slice(3, 4)
    return Number.parseInt(digit + digit, 16) / 255
  }
  return 1
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

type Rgb = readonly [number, number, number]

function hex(rgb: Rgb): string {
  return `#${rgb.map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** What a translucent fill actually looks like once it is over the page. */
function composite(fill: Rgb, alpha: number, ground: Rgb): Rgb {
  return [0, 1, 2].map((i) => fill[i] * alpha + ground[i] * (1 - alpha)) as unknown as Rgb
}

/** The largest per-channel difference — how far apart two surfaces LOOK. */
function gap(a: Rgb, b: Rgb): number {
  return Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])))
}

function shift(colour: Rgb, delta: number): Rgb {
  return colour.map((value) => clamp(value + delta)) as unknown as Rgb
}

/**
 * How far apart two stacked surfaces have to be to read as two surfaces.
 *
 * Twelve of 255. Measured rather than picked: at the old derivation, 55 of the
 * 104 concepts came out under 3 and twelve of them under 1 — that is, identical
 * — and the screen those produce is the flat one this whole redesign was
 * reported for. Twelve is the smallest step that still reads through a border
 * and a shadow on a phone, and small enough that a concept keeps its own key.
 */
const MIN_SURFACE_STEP = 12

/**
 * Push `value` away from `reference` until the two are visibly different.
 *
 * `direction` is where the concept itself wants to go — lighter on a palette
 * whose cards are lighter than its page, darker on one whose cards are darker.
 * The reverse is tried when the first runs into the black or white rail, which
 * is exactly the case that matters: a near-black card on a near-black page has
 * nowhere darker to go, so it has to come up instead.
 */
function separate(reference: Rgb, direction: 1 | -1, step: number): Rgb {
  const away = shift(reference, direction * step)
  if (gap(away, reference) >= step * 0.75) return away
  return shift(reference, -direction * step)
}

/**
 * The two surfaces the screen is made of, as they will actually RENDER.
 *
 * ── Why this is derived and not read ─────────────────────────────────────────
 *
 * The resolved palette has one surface: `card`, `popover` and `muted` are the
 * same value in all 104 concepts. The concepts plainly have two — Midnight
 * Coral Mesh fills its workspace with `#151224` and its timeline with `#0D0B17`
 * over a `#05070D` page — and collapsing them is what makes the timeline read
 * as a hole punched in the card it sits in.
 *
 * ── Why it is measured after compositing, not before ─────────────────────────
 *
 * The old version interpolated the two SPELLINGS and asserted that the strings
 * differed. They did. What they produced did not: most concepts write their
 * card with alpha — Mono Moonlight Crater's is `#080A09C7` — and a translucent
 * near-black over a near-black page renders as the page. Measured after
 * compositing, 55 concepts of 104 were putting two surfaces within 3/255 of
 * each other and twelve within 1. The test that was supposed to catch this
 * compared the strings, so it passed on every one of them.
 *
 * ── Why the raised surface keeps its alpha ───────────────────────────────────
 *
 * Because the glass is half the concept: the gradient showing through a card is
 * what `glass-dimensional` and `atmospheric` ARE. So the alpha is kept and the
 * fill behind it is solved for instead — pick the colour the card should render
 * as, then work out what fill produces it at that alpha over this page. The
 * sunken surface is left opaque: a well does not need to show the page through
 * it, and one translucency in the stack is easier to reason about than two.
 */
export function connectSurfaces(
  background: string,
  card: string,
  foreground: string,
): { readonly raised: string; readonly sunken: string } {
  const page = channels(background)
  const fill = channels(card)
  const text = channels(foreground)
  if (page === null || fill === null) return { raised: card, sunken: card }

  const alpha = alphaOf(card)
  const rendered = composite(fill, alpha, page)

  // Which way this concept lifts its cards. A palette whose card is lighter
  // than its page lifts them; one whose card is darker sinks them. When the two
  // are the same colour the palette has no opinion, so the text decides: a dark
  // page wants a lighter card, a light page a darker one.
  const lift = (values: Rgb): number => values[0] + values[1] + values[2]
  const stated = lift(fill) - lift(page)
  const direction: 1 | -1 =
    stated !== 0
      ? stated > 0
        ? 1
        : -1
      : text !== null && lift(text) > lift(page)
        ? 1
        : -1

  const raised =
    gap(rendered, page) >= MIN_SURFACE_STEP
      ? rendered
      : separate(page, direction, MIN_SURFACE_STEP)
  const sunken = separate(raised, direction === 1 ? -1 : 1, MIN_SURFACE_STEP)

  return { raised: raisedFill(raised, alpha, page), sunken: hex(sunken) }
}

/**
 * The fill to write for a card that must RENDER as `target` over `page`.
 *
 * Translucency is kept where it can be: the gradient showing through a card is
 * what `glass-dimensional` and `atmospheric` are, so the alpha stays and the
 * fill behind it is solved for.
 *
 * It cannot always be kept, and the check for that is the point of this
 * function rather than a comment about it. A fill has a ceiling — at alpha α
 * over a page of 246 the very brightest a card can render is `255α + 246(1−α)`,
 * which for Celadon Aqua Veil's 56% is 251 — so the solve clamps at the rail
 * and quietly gives back a card that renders as its page again. Two concepts of
 * the 104 are in that position. They are drawn opaque, because the separation
 * is what was reported and the transparency is what was not.
 */
function raisedFill(target: Rgb, alpha: number, page: Rgb): string {
  if (alpha >= 1) return hex(target)
  const fill = solveFill(target, alpha, page)
  return gap(composite(fill, alpha, page), target) <= 1
    ? hex(fill) + alphaByte(alpha)
    : hex(target)
}

/** The fill that composites to `target` at `alpha` over `ground`. */
function solveFill(target: Rgb, alpha: number, ground: Rgb): Rgb {
  return [0, 1, 2].map((i) =>
    clamp((target[i] - ground[i] * (1 - alpha)) / alpha),
  ) as unknown as Rgb
}

function alphaByte(alpha: number): string {
  return Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')
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
  // Both surfaces together, and both measured after compositing: a card
  // written with alpha over a page of nearly the same colour renders as the
  // page, and 55 of the 104 concepts were doing exactly that.
  const surfaces = connectSurfaces(
    values['background'] ?? '#000000',
    values['card'] ?? values['background'] ?? '#000000',
    foreground,
  )
  tokens['color-surface-high'] = surfaces.raised
  tokens['color-surface'] = surfaces.sunken
  // 24% and 40%: the two weights the concepts alternate between for a divider
  // and an outline.
  tokens['color-border-soft'] = hairline(primary, foreground, 0.24)
  tokens['color-border-strong'] = hairline(primary, foreground, 0.4)

  // Radii travel because they are half of what separates a concept from a
  // palette: `surfaceRadius` is the corner the cards are drawn with, and
  // `canonicalRadius` the one the controls use.
  //
  // There is no `radius-pill`, and that is not an omission. The screen used to
  // draw its buttons and its platform control at 9999px, so a concept with a
  // 15px card held a row of lozenges — reported as "нарушают тему". The page
  // this screen replaces gives every surface, chip and button one radius, and
  // that is now the rule: the screen reads these two tokens and nothing else.
  // A control is never rounder than the surface holding it. The generator
  // classifies the two independently and disagreed with itself on 35 of the
  // 104 — Mono Moonlight Crater comes out as a 15px card holding 22px chips,
  // which reads as chips that overflowed their card rather than as a concept.
  // Nothing on any artboard does that, so the smaller of the two wins.
  const cardRadius = descriptor.classification.surfaceRadius
  tokens['radius-card'] = `${cardRadius}px`
  tokens['radius-item'] = `${Math.min(descriptor.classification.canonicalRadius, cardRadius)}px`
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
