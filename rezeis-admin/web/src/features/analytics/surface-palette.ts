/**
 * The colours of the four usage rings on the analytics page.
 *
 * KEYED BY CATEGORY, NEVER BY RANK. iOS is one colour in «ОС» and in «Установки
 * PWA по ОС», whatever its place in either ring, and it keeps that colour when a
 * refetch reorders the slices. A palette handed out in rank order — the way the
 * other donuts on this page still take `DONUT_COLORS[i]` — would paint iOS pink
 * in one ring and plum in the next as soon as Android overtook it in one of
 * them.
 *
 * NOT THE THEME'S `--chart-*`. A theme may make those a grey ramp (the owner's
 * did — see `dashboard-client-apps.tsx`), and these slices have to stay apart on
 * any theme.
 *
 * WHY THESE FIVE. Green, amber, orange and red are the statuses' — this page's
 * provider badges, the dashboard's subscription ring, `--destructive` — and none
 * of these categories is a status. That leaves roughly the arc from cyan to pink,
 * and five colours along it can only be told apart by alternating lightness as
 * well as hue. They were SEARCHED, not picked: every in-gamut oklch with L 0.53–
 * 0.73 and C ≥ 0.1 was scored on the worst pair inside any one ring, both as
 * seen and under simulated protanopia and deuteranopia, holding each colour
 * clear of every status colour. The result, measured again in
 * `surface-palette.test.ts`:
 *
 *   - worst pair inside a ring 0.160 in OKLab (the sky and the lavender of
 *     «Поверхность»), and 0.086 under simulated protanopia/deuteranopia;
 *   - nearest status colour 0.127 (the pink, from the dark theme's
 *     `--destructive`);
 *   - every hue at least 2.3:1 on the white card and 3.2:1 on the dark one.
 *
 * One set serves both themes, as the dashboard's does: an operator theme may
 * have a card that is neither white nor near-black. The price is that the sky,
 * the lavender and the pink sit above the lightness a dark-only palette would
 * choose (0.67–0.73 against ~0.67) — measured to stay distinct, not glaring.
 *
 * WHAT A COLOUR MEANS ACROSS RINGS. Within a ring a colour names one category.
 * Across rings the same colour is reused, and the reuse is chosen so that a
 * rhyme, where there is one, is a true one: the phone-and-tablet half of
 * «Устройство» is pink and plum, and so are iOS and Android; desktops are blue,
 * and so is Windows. The surface ring keeps the cool half: Telegram's sky for
 * Mini App, PWA's violet for PWA.
 */

/** One ring's dimension, as the report names its breakdowns. */
export type SurfaceDimension = 'surface' | 'form' | 'os'

export const SURFACE_HUES = {
  sky: 'oklch(0.73 0.14 228)',
  blue: 'oklch(0.53 0.19 258)',
  lavender: 'oklch(0.67 0.17 284)',
  plum: 'oklch(0.54 0.16 323)',
  pink: 'oklch(0.73 0.12 343)',
} as const

/** The folded "Другое" of every ring: the dashboard's own neutral, so "other" reads the same on both pages. */
export const SURFACE_OTHER_COLOR = 'oklch(0.6 0.02 260)'

/**
 * An install whose OS is no longer on record. Lighter than "Другое" so the two
 * neutrals stay apart in the one ring that can hold both, and pale on purpose:
 * it is the slice that says "we do not know", not one more category.
 */
export const SURFACE_UNKNOWN_COLOR = 'oklch(0.84 0.02 260)'

export const SURFACE_CATEGORY_COLORS: {
  readonly [D in SurfaceDimension]: Readonly<Record<string, string>>
} = {
  surface: { tma: SURFACE_HUES.sky, browser: SURFACE_HUES.blue, pwa: SURFACE_HUES.lavender },
  form: { mobile: SURFACE_HUES.pink, tablet: SURFACE_HUES.plum, desktop: SURFACE_HUES.blue },
  os: {
    ios: SURFACE_HUES.pink,
    android: SURFACE_HUES.plum,
    windows: SURFACE_HUES.blue,
    macos: SURFACE_HUES.lavender,
    linux: SURFACE_HUES.sky,
  },
}

/** The bucket the report puts an install in when its OS is not on record. */
export const PWA_INSTALL_OS_UNKNOWN = 'unknown'

/**
 * The colour of one category. Anything the palette does not name — `other`, or
 * a value a newer cabinet starts sending — takes the neutral, so it never
 * borrows a colour that already means something else in the same ring.
 */
export function surfaceCategoryColor(dimension: SurfaceDimension, key: string): string {
  if (dimension === 'os' && key === PWA_INSTALL_OS_UNKNOWN) return SURFACE_UNKNOWN_COLOR
  return Object.hasOwn(SURFACE_CATEGORY_COLORS[dimension], key)
    ? (SURFACE_CATEGORY_COLORS[dimension][key] as string)
    : SURFACE_OTHER_COLOR
}
