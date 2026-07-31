/**
 * Canonical appearance concepts derived from the read-only 104-concept book.
 *
 * Keep this module data-driven: the compact descriptors are shared by the
 * preset gallery and the deterministic shadcn CSS generator below.
 */

export type HexColor = `#${string}`
export type ConceptMobileWidth = 360 | 390 | 393 | 430
export type ConceptBackgroundType =
  | 'solid'
  | 'linear-gradient'
  | 'radial-gradient'
  | 'mesh-gradient'
export type ConceptRadiusSource =
  | 'eco-radius-variable'
  | 'matched-rezeis-reiwa-sidebar'
export type ConceptRadiusClass = 'square' | 'compact' | 'rounded' | 'pillowy'
export type ConceptEffectClass = 'flat' | 'blur' | 'shadow' | 'blur-shadow'
export type ConceptDecorDensity = 'none' | 'light' | 'medium' | 'dense'
export type ConceptVisualFamily =
  | 'glass'
  | 'glass-dimensional'
  | 'editorial'
  | 'hard-edge'
  | 'technical'
  | 'atmospheric'
export type ConceptSourceMode = 'light' | 'dark'

export type ConceptPalette = readonly [
  HexColor,
  HexColor,
  HexColor,
  HexColor,
  HexColor,
  HexColor,
  HexColor,
  HexColor,
]

export interface ConceptClassification {
  readonly backgroundType: ConceptBackgroundType
  readonly surfaceRadius: number
  readonly canonicalRadius: number
  readonly radiusSource: ConceptRadiusSource
  readonly radiusClass: ConceptRadiusClass
  readonly effectClass: ConceptEffectClass
  readonly backgroundBlur: boolean
  readonly shadow: boolean
  readonly directDecorCount: number
  readonly decorDensity: ConceptDecorDensity
  readonly visualFamily: ConceptVisualFamily
  readonly visualTags: readonly string[]
}

export interface ConceptPresetDescriptor {
  readonly id: `concept-${string}`
  readonly code: string
  readonly name: string
  readonly palette: ConceptPalette
  readonly fonts: readonly [string, ...string[]]
  /** Specification page in rezeis-subpage-concept-book-104.pdf. */
  readonly sourcePage: number
  readonly mobileWidth: ConceptMobileWidth
  readonly classification: ConceptClassification
}

/**
 * Exact Rezeis dashboard semantics audited from the ecosystem boards in
 * subscription.pen. Mesh fills are represented as null because Pencil exports
 * them as raster data URLs; the generator recreates those as layered CSS
 * gradients from the approved eight-colour palette.
 */
export interface ConceptSourceStyle {
  readonly background: string | null
  readonly surface: HexColor
  readonly card: HexColor
  readonly accent: HexColor
  readonly foreground: HexColor
  readonly mutedForeground: HexColor
  readonly border: HexColor
  readonly headingFont: string
  readonly bodyFont: string
  readonly dataFont: string
}

export const CONCEPT_REQUIRED_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
] as const

type ConceptThemeToken = (typeof CONCEPT_REQUIRED_TOKENS)[number]
type ThemeTokenValues = Record<ConceptThemeToken, HexColor>

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

function parseHex(hex: HexColor): Rgb {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
    a:
      hex.length >= 9
        ? Number.parseInt(hex.slice(7, 9), 16) / 255
        : 1,
  }
}

function channelToLinear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: HexColor): number {
  const { r, g, b } = parseHex(hex)
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  )
}

function contrastRatio(a: HexColor, b: HexColor): number {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))
  return (light + 0.05) / (dark + 0.05)
}

function rgbChroma(hex: HexColor): number {
  const { r, g, b } = parseHex(hex)
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255
}

function mixHex(a: HexColor, b: HexColor, weightA: number): HexColor {
  const first = parseHex(a)
  const second = parseHex(b)
  const weightB = 1 - weightA
  const channel = (left: number, right: number): string =>
    Math.round(left * weightA + right * weightB)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()

  return `#${channel(first.r, second.r)}${channel(first.g, second.g)}${channel(first.b, second.b)}`
}

function flattenHex(color: HexColor, backdrop: HexColor): HexColor {
  const { a } = parseHex(color)
  return a >= 1 ? (`${color.slice(0, 7)}` as HexColor) : mixHex(color, backdrop, a)
}

function withAlpha(color: HexColor, alpha: number): HexColor {
  const byte = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase()
  return `${color.slice(0, 7)}${byte}` as HexColor
}

function pickTextColor(
  surface: HexColor,
  darkest: HexColor,
  lightest: HexColor,
  backdrop: HexColor = surface,
): HexColor {
  const opaqueSurface = flattenHex(surface, backdrop)
  return contrastRatio(opaqueSurface, darkest) >=
    contrastRatio(opaqueSurface, lightest)
    ? darkest
    : lightest
}

const PURE_BLACK: HexColor = '#000000'
const PURE_WHITE: HexColor = '#FFFFFF'

function bestNeutralContrast(surface: HexColor): HexColor {
  return contrastRatio(surface, PURE_BLACK) >= contrastRatio(surface, PURE_WHITE)
    ? PURE_BLACK
    : PURE_WHITE
}

/**
 * Preserve the approved colour whenever it is readable. Otherwise move only
 * as far as necessary towards the best neutral contrast colour. This keeps
 * the source identity while making text, focus indicators and data graphics
 * usable in every generated mode.
 */
function ensureContrast(
  preferred: HexColor,
  surface: HexColor,
  minimum: number,
): HexColor {
  const opaqueSurface = flattenHex(surface, bestNeutralContrast(surface))
  const opaquePreferred = flattenHex(preferred, opaqueSurface)
  if (contrastRatio(opaquePreferred, opaqueSurface) >= minimum) {
    return preferred
  }

  const target = bestNeutralContrast(opaqueSurface)
  for (let preferredWeight = 0.99; preferredWeight >= 0; preferredWeight -= 0.01) {
    const candidate = mixHex(opaquePreferred, target, preferredWeight)
    if (contrastRatio(candidate, opaqueSurface) >= minimum) return candidate
  }
  return target
}

function pickAccent(
  palette: ConceptPalette,
  excluded?: HexColor,
): HexColor {
  const available = palette.filter((color) => color !== excluded)
  const candidates = available.length > 0 ? available : palette

  return [...candidates].sort((a, b) => {
    const score = (color: HexColor): number => {
      const lightnessBalance = 1 - Math.abs(luminance(color) - 0.5) * 2
      return rgbChroma(color) * 1.5 + lightnessBalance * 0.15
    }
    return score(b) - score(a)
  })[0]
}

function createChartPalette(
  palette: ConceptPalette,
  primary: HexColor,
  secondaryAccent: HexColor,
): readonly [HexColor, HexColor, HexColor, HexColor, HexColor] {
  const unique = [primary, secondaryAccent, ...palette].filter(
    (color, index, colors) => colors.indexOf(color) === index,
  )
  while (unique.length < 5) unique.push(palette[unique.length % palette.length])
  return [unique[0], unique[1], unique[2], unique[3], unique[4]]
}

function backgroundColors(background: string | null): HexColor[] {
  if (background === null) return []
  return backgroundColorStops(background).map(
    (color) => color.slice(0, 7) as HexColor,
  )
}

function backgroundColorStops(background: string): HexColor[] {
  return [
    ...background.matchAll(
      /#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?(?![0-9A-Fa-f])/g,
    ),
  ].map(([color]) => color.toUpperCase() as HexColor)
}

function splitBackgroundLayers(background: string): string[] {
  const layers: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < background.length; index += 1) {
    const character = background[index]
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) {
      layers.push(background.slice(start, index).trim())
      start = index + 1
    }
  }

  const tail = background.slice(start).trim()
  if (tail.length > 0 && tail !== 'none') layers.push(tail)
  return layers
}

function backgroundContrastSamples(
  background: string,
  bodyBackground: HexColor,
): HexColor[] {
  let samples: HexColor[] = [bodyBackground]

  // CSS paints the first listed layer on top, so compose from the bottom up.
  for (const layer of splitBackgroundLayers(background).reverse()) {
    const stops = backgroundColorStops(layer)
    if (stops.length === 0) continue
    const canExposeUnderlying =
      /\btransparent\b/i.test(layer) ||
      stops.some((stop) => parseHex(stop).a === 0)
    const composited = canExposeUnderlying ? [...samples] : []

    for (const stop of stops) {
      const alpha = parseHex(stop).a
      if (alpha >= 1) {
        composited.push(stop.slice(0, 7) as HexColor)
      } else if (alpha > 0) {
        composited.push(
          ...samples.map((sample) => flattenHex(stop, sample)),
        )
      }
    }

    samples = [...new Set(composited)]
  }

  return samples
}

/**
 * Bare page copy is painted directly over the fixed concept background.
 * Some source boards intentionally mix very light and very dark stops, so no
 * single foreground can remain readable over the unmodified artwork. Keep the
 * approved composition intact and add only the smallest neutral support veil
 * needed for WCAG AA normal text. The byte-rounded safety margin also covers
 * CSS alpha quantisation.
 */
function backgroundReadabilityOverlay(
  background: string,
  bodyBackground: HexColor,
  foreground: HexColor,
): HexColor {
  const samples = backgroundContrastSamples(background, bodyBackground)
  const support = bestNeutralContrast(foreground)
  let requiredOpacity = 0

  for (const sample of samples) {
    if (contrastRatio(foreground, sample) >= 4.5) continue

    let low = 0
    let high = 1
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const midpoint = (low + high) / 2
      const supported = mixHex(support, sample, midpoint)
      if (contrastRatio(foreground, supported) >= 4.5) {
        high = midpoint
      } else {
        low = midpoint
      }
    }
    requiredOpacity = Math.max(requiredOpacity, high)
  }

  if (requiredOpacity === 0) return withAlpha(support, 0)
  const safeOpacity = Math.min(1, requiredOpacity + 0.025)
  const alphaByte = Math.ceil(safeOpacity * 255)
  return withAlpha(support, alphaByte / 255)
}

function sourceBackgroundColor(
  descriptor: ConceptPresetDescriptor,
  source: ConceptSourceStyle,
): HexColor {
  const candidates = backgroundColors(source.background)
  const colors = candidates.length > 0 ? candidates : [...descriptor.palette]
  return [...colors].sort(
    (a, b) =>
      contrastRatio(b, source.foreground) -
      contrastRatio(a, source.foreground),
  )[0]
}

export function getConceptSourceBackgroundColor(
  descriptor: ConceptPresetDescriptor,
): HexColor {
  const source = getConceptSourceStyle(descriptor)
  return sourceBackgroundColor(descriptor, source)
}

export function getConceptSourceMode(
  descriptor: ConceptPresetDescriptor,
): ConceptSourceMode {
  return luminance(getConceptSourceStyle(descriptor).foreground) >= 0.5
    ? 'dark'
    : 'light'
}

function ensureMutedContrast(
  preferred: HexColor,
  background: HexColor,
  fallback: HexColor,
): HexColor {
  const candidate = ensureContrast(preferred, background, 4.5)
  return contrastRatio(candidate, background) >= 4.5 ? candidate : fallback
}

function buildSourceTokens(
  descriptor: ConceptPresetDescriptor,
  source: ConceptSourceStyle,
): ThemeTokenValues {
  const sorted = [...descriptor.palette].sort(
    (a, b) => luminance(a) - luminance(b),
  )
  const darkest = sorted[0]
  const background = sourceBackgroundColor(descriptor, source)
  const foreground = source.foreground
  const primary = source.accent
  const primaryForeground = bestNeutralContrast(flattenHex(primary, background))
  const secondaryAccent = pickAccent(descriptor.palette, primary)
  const charts = createChartPalette(
    descriptor.palette,
    primary,
    secondaryAccent,
  )
  const sourceMode = getConceptSourceMode(descriptor)
  const accent = withAlpha(primary, sourceMode === 'dark' ? 0.2 : 0.14)
  const accentForeground = bestNeutralContrast(flattenHex(accent, background))
  const opaqueCard = flattenHex(source.card, background)
  const cardForeground = ensureContrast(source.foreground, opaqueCard, 4.6)
  const opaqueSidebar = flattenHex(source.surface, background)
  const sidebarForeground = ensureContrast(
    source.foreground,
    opaqueSidebar,
    4.6,
  )
  const border = ensureContrast(source.border, background, 3.1)
  const sidebarBorder = ensureContrast(source.border, opaqueSidebar, 3.1)
  const ring = ensureContrast(primary, background, 3.1)
  const sidebarRing = ensureContrast(primary, opaqueSidebar, 3.1)
  const accessibleCharts = charts.map((chart) =>
    ensureContrast(chart, background, 3.1),
  ) as unknown as readonly [HexColor, HexColor, HexColor, HexColor, HexColor]

  return {
    background,
    foreground,
    card: source.card,
    'card-foreground': cardForeground,
    popover: source.card,
    'popover-foreground': cardForeground,
    primary,
    'primary-foreground': primaryForeground,
    secondary: source.surface,
    'secondary-foreground': sidebarForeground,
    muted: source.card,
    'muted-foreground': ensureMutedContrast(
      source.mutedForeground,
      flattenHex(source.card, background),
      cardForeground,
    ),
    accent,
    'accent-foreground': accentForeground,
    destructive: sourceMode === 'dark' ? '#F87171' : '#DC2626',
    'destructive-foreground': sourceMode === 'dark' ? darkest : '#FFFFFF',
    border,
    input: border,
    ring,
    'chart-1': accessibleCharts[0],
    'chart-2': accessibleCharts[1],
    'chart-3': accessibleCharts[2],
    'chart-4': accessibleCharts[3],
    'chart-5': accessibleCharts[4],
    sidebar: source.surface,
    'sidebar-foreground': sidebarForeground,
    'sidebar-primary': primary,
    'sidebar-primary-foreground': primaryForeground,
    'sidebar-accent': accent,
    'sidebar-accent-foreground': accentForeground,
    'sidebar-border': sidebarBorder,
    'sidebar-ring': sidebarRing,
  }
}

function buildOppositeTokens(
  descriptor: ConceptPresetDescriptor,
  source: ConceptSourceStyle,
  mode: ConceptSourceMode,
): ThemeTokenValues {
  const sorted = [...descriptor.palette].sort(
    (a, b) => luminance(a) - luminance(b),
  )
  const darkest = sorted[0]
  const secondDarkest = sorted[1]
  const secondLightest = sorted.at(-2) ?? sorted[0]
  const lightest = sorted.at(-1) ?? sorted[0]
  const isLight = mode === 'light'
  const background = isLight ? lightest : darkest
  const foreground = isLight ? darkest : lightest
  const primary = source.accent
  const secondaryAccent = pickAccent(descriptor.palette, primary)
  const charts = createChartPalette(
    descriptor.palette,
    primary,
    secondaryAccent,
  )
  const card = isLight
    ? mixHex(lightest, secondLightest, 0.64)
    : mixHex(darkest, secondDarkest, 0.58)
  const surface = mixHex(background, primary, isLight ? 0.94 : 0.9)
  const accent = withAlpha(primary, isLight ? 0.14 : 0.2)
  const border = ensureContrast(
    mixHex(background, foreground, isLight ? 0.8 : 0.76),
    background,
    3.1,
  )
  const sidebarBorder = ensureContrast(border, surface, 3.1)
  const cardForeground = pickTextColor(
    card,
    darkest,
    lightest,
    background,
  )
  const accentForeground = pickTextColor(
    accent,
    darkest,
    lightest,
    background,
  )
  const primaryForeground = bestNeutralContrast(flattenHex(primary, background))
  const ring = ensureContrast(primary, background, 3.1)
  const sidebarRing = ensureContrast(primary, surface, 3.1)
  const accessibleCharts = charts.map((chart) =>
    ensureContrast(chart, background, 3.1),
  ) as unknown as readonly [HexColor, HexColor, HexColor, HexColor, HexColor]

  return {
    background,
    foreground,
    card,
    'card-foreground': cardForeground,
    popover: card,
    'popover-foreground': cardForeground,
    primary,
    'primary-foreground': primaryForeground,
    secondary: surface,
    'secondary-foreground': foreground,
    muted: mixHex(background, foreground, isLight ? 0.9 : 0.82),
    'muted-foreground': ensureMutedContrast(
      mixHex(foreground, background, 0.68),
      mixHex(background, foreground, isLight ? 0.9 : 0.82),
      foreground,
    ),
    accent,
    'accent-foreground': accentForeground,
    destructive: isLight ? '#DC2626' : '#F87171',
    'destructive-foreground': isLight ? '#FFFFFF' : darkest,
    border,
    input: border,
    ring,
    'chart-1': accessibleCharts[0],
    'chart-2': accessibleCharts[1],
    'chart-3': accessibleCharts[2],
    'chart-4': accessibleCharts[3],
    'chart-5': accessibleCharts[4],
    sidebar: surface,
    'sidebar-foreground': foreground,
    'sidebar-primary': primary,
    'sidebar-primary-foreground': primaryForeground,
    'sidebar-accent': accent,
    'sidebar-accent-foreground': accentForeground,
    'sidebar-border': sidebarBorder,
    'sidebar-ring': sidebarRing,
  }
}

function buildThemeTokens(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
): ThemeTokenValues {
  const source = getConceptSourceStyle(descriptor)
  return mode === getConceptSourceMode(descriptor)
    ? buildSourceTokens(descriptor, source)
    : buildOppositeTokens(descriptor, source, mode)
}

function quoteFont(font: string): string {
  return `"${font.replaceAll('"', '\\"')}"`
}

function runtimeFontName(font: string): string {
  if (font === 'IBM Plex Mono') return font
  if (
    [
      'Geist',
      'Funnel Sans',
      'Archivo',
      'Archivo Narrow',
      'Nunito',
      'Newsreader',
      'Playfair Display',
      'Source Sans 3',
      'Space Grotesk',
    ].includes(font)
  ) {
    return `${font} Variable`
  }
  return font
}

function fontDeclarations(
  descriptor: ConceptPresetDescriptor,
): readonly string[] {
  const source = getConceptSourceStyle(descriptor)
  const mono = /mono/i.test(source.dataFont)
    ? source.dataFont
    : descriptor.fonts.find((font) => /mono/i.test(font)) ?? 'IBM Plex Mono'
  const serif =
    [source.headingFont, source.bodyFont, ...descriptor.fonts].find((font) =>
      /newsreader|playfair|serif/i.test(font),
    ) ?? 'ui-serif'
  const heading = quoteFont(runtimeFontName(source.headingFont))
  const body = quoteFont(runtimeFontName(source.bodyFont))
  const data = quoteFont(runtimeFontName(source.dataFont))

  return [
    `  --font-heading: ${heading}, ui-sans-serif, system-ui, sans-serif;`,
    `  --font-body: ${body}, ui-sans-serif, system-ui, sans-serif;`,
    `  --font-data: ${data}, ui-monospace, monospace;`,
    `  --font-sans: ${body}, ui-sans-serif, system-ui, sans-serif;`,
    `  --font-serif: ${quoteFont(runtimeFontName(serif))}, ui-serif, Georgia, serif;`,
    `  --font-mono: ${quoteFont(runtimeFontName(mono))}, ui-monospace, monospace;`,
    `  --radius: ${descriptor.classification.canonicalRadius}px;`,
    '  font-family: var(--font-body);',
  ]
}

function buildMeshBackground(
  descriptor: ConceptPresetDescriptor,
  values: ThemeTokenValues,
): string {
  const [first, second, third, fourth] = createChartPalette(
    descriptor.palette,
    values.primary,
    values['chart-2'],
  )
  return [
    `radial-gradient(circle at 12% 14%, ${withAlpha(first, 0.72)} 0%, transparent 42%)`,
    `radial-gradient(circle at 86% 12%, ${withAlpha(second, 0.58)} 0%, transparent 44%)`,
    `radial-gradient(circle at 76% 84%, ${withAlpha(third, 0.52)} 0%, transparent 48%)`,
    `radial-gradient(circle at 18% 88%, ${withAlpha(fourth, 0.42)} 0%, transparent 46%)`,
    `linear-gradient(135deg, ${values.background} 0%, ${values.card} 100%)`,
  ].join(', ')
}

function buildOppositeBaseBackground(
  descriptor: ConceptPresetDescriptor,
  values: ThemeTokenValues,
): string {
  switch (descriptor.classification.backgroundType) {
    case 'solid':
      return 'none'
    case 'radial-gradient':
      return `radial-gradient(circle at 76% 6%, ${withAlpha(values.primary, 0.34)} 0%, ${values.background} 68%)`
    case 'mesh-gradient':
      return buildMeshBackground(descriptor, values)
    case 'linear-gradient':
      return `linear-gradient(135deg, ${values.background} 0%, ${values.card} 52%, ${withAlpha(values.primary, 0.24)} 100%)`
  }
}

function buildModeBaseBackground(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
  values: ThemeTokenValues,
): string {
  const source = getConceptSourceStyle(descriptor)
  if (mode !== getConceptSourceMode(descriptor)) {
    return buildOppositeBaseBackground(descriptor, values)
  }
  if (descriptor.classification.backgroundType === 'mesh-gradient') {
    return buildMeshBackground(descriptor, values)
  }
  return source.background?.startsWith('#') === true
    ? 'none'
    : source.background ?? 'none'
}

function seededUnit(code: string, salt: number): number {
  let value = salt * 97
  for (const character of code) {
    value = (value * 31 + character.charCodeAt(0)) % 10_007
  }
  return value / 10_007
}

function seededPercent(
  descriptor: ConceptPresetDescriptor,
  salt: number,
  minimum: number,
  maximum: number,
): string {
  const value = minimum + seededUnit(descriptor.code, salt) * (maximum - minimum)
  return `${value.toFixed(1)}%`
}

function decorStrength(descriptor: ConceptPresetDescriptor): number {
  const base: Record<ConceptDecorDensity, number> = {
    none: 0,
    light: 0.1,
    medium: 0.14,
    dense: 0.18,
  }
  return Math.min(
    0.24,
    base[descriptor.classification.decorDensity] +
      descriptor.classification.directDecorCount * 0.003,
  )
}

function decorLayerCount(
  descriptor: ConceptPresetDescriptor,
  availableLayers: number,
): number {
  if (descriptor.classification.directDecorCount <= 0) return 0

  const densityLimit: Record<ConceptDecorDensity, number> = {
    none: 0,
    light: 1,
    medium: 2,
    dense: 4,
  }
  const directDecorLimit = Math.ceil(
    descriptor.classification.directDecorCount / 4,
  )
  return Math.min(
    availableLayers,
    densityLimit[descriptor.classification.decorDensity],
    directDecorLimit,
  )
}

function polarRedMonolithDecor(
  descriptor: ConceptPresetDescriptor,
  strength: number,
): readonly string[] {
  const blue = descriptor.palette[3]
  const mutedBlue = descriptor.palette[5]
  const red = descriptor.palette[2]

  return [
    `conic-gradient(from 0deg at 86% 40%, ${withAlpha(blue, strength)} 0deg 90deg, transparent 90deg 360deg)`,
    `conic-gradient(from 0deg at 70% 40%, ${withAlpha(red, strength * 0.82)} 0deg 90deg, transparent 90deg 360deg)`,
    `conic-gradient(from 180deg at 32% 72%, ${withAlpha(blue, strength * 0.64)} 0deg 90deg, transparent 90deg 360deg)`,
    `conic-gradient(from 180deg at 70% 86%, ${withAlpha(mutedBlue, strength * 0.52)} 0deg 90deg, transparent 90deg 360deg)`,
  ]
}

/**
 * Reconstruct the semantic atmosphere that is visible in the concept boards
 * but cannot be stored as Pencil raster data. Every position is derived from
 * the stable concept code, so the same descriptor always yields identical CSS.
 */
function semanticDecorLayers(
  descriptor: ConceptPresetDescriptor,
  values: ThemeTokenValues,
): readonly string[] {
  const strength = decorStrength(descriptor)
  if (strength === 0) return []
  if (descriptor.code === 'CU') {
    return polarRedMonolithDecor(descriptor, strength)
  }

  const [first, second, third, fourth] = createChartPalette(
    descriptor.palette,
    values.primary,
    values['chart-2'],
  )
  const x1 = seededPercent(descriptor, 1, 12, 38)
  const y1 = seededPercent(descriptor, 2, 8, 34)
  const x2 = seededPercent(descriptor, 3, 66, 92)
  const y2 = seededPercent(descriptor, 4, 62, 92)
  const bandStart = seededPercent(descriptor, 5, 58, 72)
  const bandEnd = seededPercent(descriptor, 6, 78, 92)
  const familyLayers: Record<ConceptVisualFamily, readonly string[]> = {
    glass: [
      `radial-gradient(ellipse 54% 48% at ${x1} ${y1}, ${withAlpha(first, strength)} 0%, transparent 68%)`,
      `radial-gradient(ellipse 48% 42% at ${x2} ${y2}, ${withAlpha(second, strength * 0.82)} 0%, transparent 72%)`,
      `linear-gradient(118deg, transparent 18%, ${withAlpha(PURE_WHITE, strength * 0.36)} 46%, transparent 68%)`,
      `radial-gradient(circle at 50% 48%, transparent 0 34%, ${withAlpha(third, strength * 0.42)} 35%, transparent 58%)`,
    ],
    'glass-dimensional': [
      `radial-gradient(ellipse 58% 48% at ${x1} ${y1}, ${withAlpha(first, strength)} 0%, transparent 66%)`,
      `radial-gradient(circle at ${x2} ${y2}, transparent 0 18%, ${withAlpha(PURE_WHITE, strength * 0.5)} 19%, ${withAlpha(second, strength * 0.54)} 28%, transparent 48%)`,
      `linear-gradient(112deg, transparent 22%, ${withAlpha(PURE_WHITE, strength * 0.42)} 47%, transparent 64%)`,
      `radial-gradient(ellipse 70% 32% at 50% 104%, ${withAlpha(fourth, strength * 0.7)} 0%, transparent 72%)`,
    ],
    editorial: [
      `conic-gradient(from 0deg at ${bandStart} 42%, ${withAlpha(first, strength * 0.72)} 0deg 90deg, transparent 90deg 360deg)`,
      `conic-gradient(from 180deg at 34% 78%, ${withAlpha(second, strength * 0.58)} 0deg 90deg, transparent 90deg 360deg)`,
      `linear-gradient(90deg, transparent 0 ${bandStart}, ${withAlpha(third, strength * 0.44)} ${bandStart} ${bandEnd}, transparent ${bandEnd})`,
      `repeating-linear-gradient(0deg, transparent 0 23px, ${withAlpha(values.foreground, strength * 0.12)} 23px 24px)`,
    ],
    'hard-edge': [
      `conic-gradient(from 0deg at ${bandStart} 38%, ${withAlpha(first, strength)} 0deg 90deg, transparent 90deg 360deg)`,
      `conic-gradient(from 180deg at 36% 76%, ${withAlpha(second, strength * 0.72)} 0deg 90deg, transparent 90deg 360deg)`,
      `linear-gradient(90deg, transparent 0 ${bandStart}, ${withAlpha(third, strength * 0.58)} ${bandStart} ${bandEnd}, transparent ${bandEnd})`,
      `repeating-linear-gradient(135deg, transparent 0 26px, ${withAlpha(fourth, strength * 0.24)} 26px 28px)`,
    ],
    technical: [
      `repeating-linear-gradient(90deg, transparent 0 31px, ${withAlpha(first, strength * 0.34)} 31px 32px)`,
      `repeating-linear-gradient(0deg, transparent 0 31px, ${withAlpha(second, strength * 0.28)} 31px 32px)`,
      `radial-gradient(circle at ${x2} ${y1}, ${withAlpha(third, strength * 0.74)} 0 2px, transparent 3px 100%)`,
      `linear-gradient(90deg, transparent 0 ${bandStart}, ${withAlpha(fourth, strength * 0.46)} ${bandStart} ${bandEnd}, transparent ${bandEnd})`,
    ],
    atmospheric: [
      `radial-gradient(ellipse 72% 44% at ${x1} ${y1}, ${withAlpha(first, strength)} 0%, transparent 70%)`,
      `radial-gradient(ellipse 64% 38% at ${x2} ${y2}, ${withAlpha(second, strength * 0.78)} 0%, transparent 74%)`,
      `linear-gradient(180deg, ${withAlpha(third, strength * 0.34)} 0%, transparent 42% 70%, ${withAlpha(fourth, strength * 0.28)} 100%)`,
      `radial-gradient(ellipse 90% 24% at 50% 108%, ${withAlpha(first, strength * 0.48)} 0%, transparent 72%)`,
    ],
  }
  const tagLayers: string[] = []
  if (
    descriptor.classification.visualTags.includes('atmospheric') &&
    descriptor.classification.visualFamily !== 'atmospheric'
  ) {
    tagLayers.push(
      `radial-gradient(ellipse 82% 28% at 50% 106%, ${withAlpha(second, strength * 0.42)} 0%, transparent 74%)`,
    )
  }
  if (
    descriptor.classification.visualTags.includes('technical') &&
    descriptor.classification.visualFamily !== 'technical'
  ) {
    tagLayers.push(
      `repeating-linear-gradient(90deg, transparent 0 47px, ${withAlpha(values.foreground, strength * 0.1)} 47px 48px)`,
    )
  }
  if (
    descriptor.classification.visualTags.includes('editorial') &&
    descriptor.classification.visualFamily !== 'editorial'
  ) {
    tagLayers.push(
      `linear-gradient(90deg, transparent 0 ${bandStart}, ${withAlpha(third, strength * 0.3)} ${bandStart} ${bandEnd}, transparent ${bandEnd})`,
    )
  }

  const family = familyLayers[descriptor.classification.visualFamily]
  return [family[0], ...tagLayers, ...family.slice(1)]
}

function buildConceptComposition(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
  values: ThemeTokenValues,
): {
  readonly image: string
  readonly decorLayerCount: number
  readonly readabilityOverlay: HexColor
} {
  const base = buildModeBaseBackground(descriptor, mode, values)
  const availableDecor = semanticDecorLayers(descriptor, values)
  const count = decorLayerCount(descriptor, availableDecor.length)
  const layers = availableDecor.slice(0, count)
  if (base !== 'none') layers.push(base)
  const artwork = layers.length > 0 ? layers.join(', ') : 'none'
  const readabilityOverlay = backgroundReadabilityOverlay(
    artwork,
    values.background,
    values.foreground,
  )
  if (readabilityOverlay.slice(7, 9) !== '00' && artwork !== 'none') {
    layers.unshift(
      `linear-gradient(${readabilityOverlay}, ${readabilityOverlay})`,
    )
  }

  return {
    image: layers.length > 0 ? layers.join(', ') : 'none',
    decorLayerCount: count,
    readabilityOverlay,
  }
}

function shadowFor(
  descriptor: ConceptPresetDescriptor,
  values: ThemeTokenValues,
): string {
  if (!descriptor.classification.shadow) return 'none'
  const source = getConceptSourceStyle(descriptor)
  switch (descriptor.classification.visualFamily) {
    case 'hard-edge':
      return `4px 4px 0 ${withAlpha(source.border, 0.28)}`
    case 'technical':
      return `0 8px 0 ${withAlpha(values.foreground, 0.12)}, 0 18px 34px ${withAlpha(source.accent, 0.12)}`
    case 'editorial':
      return `0 2px 0 ${withAlpha(values.foreground, 0.14)}, 0 16px 30px ${withAlpha(values.foreground, 0.1)}`
    case 'glass-dimensional':
      return `inset 0 1px 0 ${withAlpha(PURE_WHITE, 0.3)}, 0 18px 46px ${withAlpha(source.accent, 0.2)}`
    case 'glass':
      return `0 14px 38px ${withAlpha(source.accent, 0.16)}`
    case 'atmospheric':
      return `0 20px 54px ${withAlpha(source.accent, 0.14)}`
  }
}

function blurFor(descriptor: ConceptPresetDescriptor): number {
  if (!descriptor.classification.backgroundBlur) return 0
  switch (descriptor.classification.visualFamily) {
    case 'glass-dimensional':
      return 24
    case 'glass':
      return 18
    case 'atmospheric':
      return 16
    case 'editorial':
      return 10
    case 'technical':
      return 8
    case 'hard-edge':
      return 0
  }
}

function conceptDeclarations(
  descriptor: ConceptPresetDescriptor,
  mode: ConceptSourceMode,
  values: ThemeTokenValues,
): readonly string[] {
  const composition = buildConceptComposition(descriptor, mode, values)
  return [
    `  --concept-background-image: ${composition.image};`,
    `  --concept-background-readability-overlay: ${composition.readabilityOverlay};`,
    `  --concept-background-type: ${descriptor.classification.backgroundType};`,
    `  --concept-composition-family: ${descriptor.classification.visualFamily};`,
    `  --concept-effect: ${descriptor.classification.effectClass};`,
    `  --concept-source-mode: ${getConceptSourceMode(descriptor)};`,
    `  --concept-surface-radius: ${descriptor.classification.surfaceRadius}px;`,
    `  --concept-canonical-radius: ${descriptor.classification.canonicalRadius}px;`,
    `  --concept-surface-radius-delta: calc(${descriptor.classification.surfaceRadius}px - ${descriptor.classification.canonicalRadius}px);`,
    `  --concept-backdrop-blur: ${blurFor(descriptor)}px;`,
    `  --concept-surface-shadow: ${shadowFor(descriptor, values)};`,
    `  --concept-decor-density: ${descriptor.classification.decorDensity};`,
    `  --concept-decor-layer-count: ${composition.decorLayerCount};`,
  ]
}

function renderTokenBlock(
  selector: ':root' | '.dark',
  values: ThemeTokenValues,
  extra: readonly string[] = [],
): string {
  const declarations = CONCEPT_REQUIRED_TOKENS.map(
    (token) => `  --${token}: ${values[token]};`,
  )
  return `${selector} {\n${[...declarations, ...extra].join('\n')}\n}`
}

function conceptRuntimeCss(): string {
  return `h1,
h2,
h3,
h4,
[data-concept-heading] {
  font-family: var(--font-heading);
}

.font-mono,
.tabular-nums,
code,
kbd,
samp,
[data-concept-data] {
  font-family: var(--font-data);
}

[data-concept-surface="card"] {
  border-radius: max(
    0px,
    calc(var(--radius) + var(--concept-surface-radius-delta, 0px))
  );
}

:root:not([data-liquid-glass-cards="on"]) [data-concept-surface="card"] {
  box-shadow: var(--concept-surface-shadow);
  -webkit-backdrop-filter: blur(var(--concept-backdrop-blur));
  backdrop-filter: blur(var(--concept-backdrop-blur));
}`
}

/**
 * Builds a complete light/dark shadcn theme without storing 104 repeated CSS
 * blocks. The same descriptor always produces byte-identical CSS.
 */
export function createConceptThemeCss(
  descriptor: ConceptPresetDescriptor,
): string {
  const light = buildThemeTokens(descriptor, 'light')
  const dark = buildThemeTokens(descriptor, 'dark')
  return [
    renderTokenBlock(':root', light, [
      ...fontDeclarations(descriptor),
      ...conceptDeclarations(descriptor, 'light', light),
    ]),
    renderTokenBlock(
      '.dark',
      dark,
      conceptDeclarations(descriptor, 'dark', dark),
    ),
    `body {
  background-color: var(--background);
  background-image: var(--concept-background-image);
  background-attachment: fixed;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
}`,
    conceptRuntimeCss(),
  ].join('\n')
}

export const CONCEPT_PRESETS = [
  { id: "concept-a", code: "A", name: "Vital Link", palette: ["#351411", "#090706", "#8E211B", "#171311", "#D8CCC5", "#2B2922", "#ECE5DF", "#FFFFFF"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 4, mobileWidth: 390, classification: { backgroundType: "radial-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 0, decorDensity: "none", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-b", code: "B", name: "Route Desk", palette: ["#26352D", "#070A09", "#F0643B", "#171B18", "#F3F0E8", "#343A34", "#969A91", "#101312"], fonts: ["Geist", "Archivo", "IBM Plex Mono"], sourcePage: 8, mobileWidth: 390, classification: { backgroundType: "radial-gradient", surfaceRadius: 12, canonicalRadius: 20, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-c", code: "C", name: "Signal Pass", palette: ["#3A2449", "#17111E", "#09080D", "#E6FF58", "#561F2C", "#302B39", "#2C1D4E", "#F5F2F7"], fonts: ["Geist", "Archivo Narrow", "IBM Plex Mono"], sourcePage: 12, mobileWidth: 390, classification: { backgroundType: "radial-gradient", surfaceRadius: 22, canonicalRadius: 20, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-d", code: "D", name: "Signal Ledger", palette: ["#E6DBFF", "#CDBAF7", "#9468FF", "#4B27B3", "#09080B", "#8F78C1", "#C5B4E9", "#F7F2FF"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 16, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 2, canonicalRadius: 14, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-e", code: "E", name: "Reiwa Pulse", palette: ["#25113B", "#0A0812", "#A855F7", "#4C1D95", "#FFFFFF", "#F8F6FB", "#8F8799", "#000000"], fonts: ["Nunito", "IBM Plex Mono"], sourcePage: 20, mobileWidth: 360, classification: { backgroundType: "radial-gradient", surfaceRadius: 24, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-f", code: "F", name: "Reiwa Minimal", palette: ["#0A0812", "#A855F7", "#FFFFFF", "#C084FC", "#77717F", "#F7F5F8", "#2B2922", "#000000"], fonts: ["Nunito", "IBM Plex Mono"], sourcePage: 24, mobileWidth: 390, classification: { backgroundType: "solid", surfaceRadius: 16, canonicalRadius: 14, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-g", code: "G", name: "Liquid Glass Aurora", palette: ["#66F3FF", "#020713", "#071123", "#0C1F35", "#A855F7", "#FFFFFF", "#000000", "#AEB8CC"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 28, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 26, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-h", code: "H", name: "Liquid Glass Frost", palette: ["#D7FCFF", "#E5DEFF", "#F6F8FF", "#EAF0F8", "#6D5DE7", "#172033", "#7965E9", "#61D6E6"], fonts: ["Nunito"], sourcePage: 32, mobileWidth: 430, classification: { backgroundType: "radial-gradient", surfaceRadius: 28, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-i", code: "I", name: "Quiet Mint", palette: ["#FBFCF7", "#EDF4EE", "#E4EEEA", "#176B55", "#17352C", "#2F8F73", "#67AA91", "#86D7BC"], fonts: ["Geist"], sourcePage: 36, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 16, canonicalRadius: 18, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-j", code: "J", name: "Cobalt Bloom", palette: ["#F8F9FF", "#EEF1FF", "#FFF5EE", "#2667FF", "#193B91", "#FF7048", "#334166", "#121828"], fonts: ["Nunito"], sourcePage: 40, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 30, canonicalRadius: 28, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-k", code: "K", name: "Fluid Metal Graphite", palette: ["#707788", "#3A3742", "#18181C", "#0D0D0F", "#071123", "#FFFFFF", "#000000", "#D9D8DA"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 44, mobileWidth: 390, classification: { backgroundType: "radial-gradient", surfaceRadius: 28, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-l", code: "L", name: "Natural Milk Glass", palette: ["#D8C1B3", "#C8D3C2", "#F1ECE4", "#E7E0D6", "#4C5A22", "#6B6255", "#344018", "#FFFFFF"], fonts: ["Nunito"], sourcePage: 48, mobileWidth: 430, classification: { backgroundType: "radial-gradient", surfaceRadius: 30, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-m", code: "M", name: "North Star Violet Glass", palette: ["#AF65C2", "#463B94", "#1B1955", "#020209", "#071123", "#F1EFF0", "#CDBBF0", "#F8FBFF"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 52, mobileWidth: 393, classification: { backgroundType: "radial-gradient", surfaceRadius: 30, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 2, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "atmospheric"] } },
  { id: "concept-n", code: "N", name: "Glacier Finance Glass", palette: ["#3D9FBC", "#064865", "#033D58", "#030405", "#00151F", "#020A0F", "#D9F7FF", "#8FE8FF"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 56, mobileWidth: 360, classification: { backgroundType: "radial-gradient", surfaceRadius: 28, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-o", code: "O", name: "Ember Smoke Glass", palette: ["#A64B1C", "#4D250C", "#1B0D08", "#030202", "#F25A25", "#F72002", "#3A180D", "#FFD5B0"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 60, mobileWidth: 390, classification: { backgroundType: "radial-gradient", surfaceRadius: 20, canonicalRadius: 18, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 2, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "atmospheric"] } },
  { id: "concept-p", code: "P", name: "Rose Orbit Clear Glass", palette: ["#F66789", "#B1393E", "#5D1D21", "#030102", "#071123", "#FDEDEF", "#F8FBFF", "#AEB8CC"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 64, mobileWidth: 430, classification: { backgroundType: "radial-gradient", surfaceRadius: 32, canonicalRadius: 32, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 2, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "atmospheric"] } },
  { id: "concept-q", code: "Q", name: "Carbon Lime Halo", palette: ["#050706", "#10170B", "#223016", "#B8F34A", "#172410", "#E5FF9A", "#9AA88E", "#F4F8EE"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 68, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 24, canonicalRadius: 20, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-r", code: "R", name: "Sienna Parchment Glass", palette: ["#F3E9DA", "#E7CDBC", "#F8F0E6", "#ECDACB", "#A85D3F", "#6E3327", "#321F19", "#7B6258"], fonts: ["Nunito"], sourcePage: 72, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 20, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-s", code: "S", name: "Celadon Aqua Veil", palette: ["#EFF8F3", "#D9EEE4", "#CDE8DD", "#177D73", "#153B37", "#0E4C49", "#48AA9A", "#5BB8A8"], fonts: ["Nunito"], sourcePage: 76, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 26, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-t", code: "T", name: "Electric Indigo Field", palette: ["#050714", "#111943", "#2438A8", "#080B22", "#526CFF", "#9AA7D8", "#F3F5FF", "#A8B7FF"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 80, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 16, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "minimal"] } },
  { id: "concept-u", code: "U", name: "Patina Copper Glass", palette: ["#041312", "#0C3733", "#17675D", "#C4774A", "#000A09", "#9ABBB3", "#F2F8F5", "#4B9B8D"], fonts: ["Geist", "Funnel Sans", "IBM Plex Mono"], sourcePage: 84, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 2, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "technical", "atmospheric"] } },
  { id: "concept-v", code: "V", name: "Smoke Pearl Mono", palette: ["#F4F5F4", "#FFFFFF", "#E4E6E5", "#272A29", "#161817", "#0E1010", "#6E7471", "#D6DAD8"], fonts: ["Nunito"], sourcePage: 88, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur", backgroundBlur: true, shadow: false, directDecorCount: 1, decorDensity: "light", visualFamily: "glass", visualTags: ["glass", "minimal"] } },
  { id: "concept-w", code: "W", name: "Lunar Lime Terminator", palette: ["#030504", "#0A1306", "#1C2C0F", "#C9FF52", "#89B832", "#B8F34A", "#96A38F", "#F5F8F3"], fonts: ["Funnel Sans"], sourcePage: 92, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-x", code: "X", name: "Martian Sienna Horizon", palette: ["#F7EADB", "#EBC9AF", "#F9F1E7", "#DFB596", "#A84B2E", "#6D2E1E", "#3B1F17", "#B64F30"], fonts: ["Newsreader"], sourcePage: 96, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-y", code: "Y", name: "Neptune Cobalt Abyss", palette: ["#020814", "#062741", "#0B4B6E", "#46D9FF", "#02131E", "#03234C", "#91B7CE", "#F2FAFF"], fonts: ["Geist"], sourcePage: 100, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-z", code: "Z", name: "Venus Pearl Atmosphere", palette: ["#FFF4F6", "#F2D3DC", "#E7C1CF", "#B9567A", "#7D3553", "#452333", "#F66789", "#A94C70"], fonts: ["Playfair Display"], sourcePage: 104, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 26, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-aa", code: "AA", name: "Arctic Eclipse Lens", palette: ["#01050A", "#071725", "#123448", "#8CE7FF", "#031018", "#8DA9BB", "#F2FAFF", "#D7F8FF"], fonts: ["IBM Plex Mono"], sourcePage: 108, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-ab", code: "AB", name: "Solar Coral Bloom", palette: ["#FFF1E6", "#F9B99F", "#FFF8F1", "#F39B7F", "#E4573D", "#A93424", "#4B241C", "#E44832"], fonts: ["Funnel Sans"], sourcePage: 112, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 26, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-ac", code: "AC", name: "Amethyst Gas Giant", palette: ["#08030D", "#24102F", "#48205B", "#D48CFF", "#17051D", "#B49AC1", "#FAF4FF", "#F0C8FF"], fonts: ["Geist"], sourcePage: 116, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 26, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-ad", code: "AD", name: "Emerald Terra Night", palette: ["#031008", "#0A3521", "#176443", "#63E6A4", "#9FC2AE", "#F3FFF8", "#BFF7D8", "#071D14"], fonts: ["Newsreader"], sourcePage: 120, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-ae", code: "AE", name: "Mono Moonlight Crater", palette: ["#050605", "#151817", "#303432", "#FFFFFF", "#969A98", "#F1F3F2", "#0E1110", "#9DA19F"], fonts: ["IBM Plex Mono"], sourcePage: 124, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 22, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-af", code: "AF", name: "Aurora Saturn Glass", palette: ["#020A0D", "#083643", "#463062", "#061319", "#67F0DB", "#061A25", "#092B31", "#9DC5C2"], fonts: ["Geist"], sourcePage: 128, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 28, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-ag", code: "AG", name: "Obsidian Signal Grid", palette: ["#030303", "#130505", "#360B09", "#FF4D44", "#A58E8A", "#FFF4F2", "#FF9B96", "#FFFFFF"], fonts: ["IBM Plex Mono"], sourcePage: 132, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 10, radiusSource: "eco-radius-variable", radiusClass: "compact", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 26, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-ah", code: "AH", name: "Butter Paper Editorial", palette: ["#F7EBCB", "#EED895", "#FFF9E9", "#E5C56A", "#A96700", "#5C3D00", "#6D4300", "#7B5200"], fonts: ["Newsreader"], sourcePage: 136, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 8, radiusSource: "eco-radius-variable", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-ai", code: "AI", name: "Biolume Trench Glass", palette: ["#01080D", "#032A38", "#07596B", "#40F0D9", "#001713", "#031820", "#88BDB8", "#EEFFFD"], fonts: ["Funnel Sans"], sourcePage: 140, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 8, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-aj", code: "AJ", name: "Bauhaus Relay", palette: ["#F3EFE5", "#D94332", "#8B241A", "#F3C51F", "#265AA8", "#FFD44A", "#171717", "#66625B"], fonts: ["Funnel Sans"], sourcePage: 144, mobileWidth: 430, classification: { backgroundType: "solid", surfaceRadius: 15, canonicalRadius: 2, radiusSource: "eco-radius-variable", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 5, decorDensity: "medium", visualFamily: "hard-edge", visualTags: ["dimensional", "hard-edge"] } },
  { id: "concept-ak", code: "AK", name: "Moss Stone Field", palette: ["#E9E3D0", "#B8C39B", "#F1EDE0", "#8FA06C", "#52652A", "#26320E", "#344214", "#2C3421"], fonts: ["Newsreader"], sourcePage: 148, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 32, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-al", code: "AL", name: "Chrome Lavender Ribbon", palette: ["#E8E9ED", "#CFC5DD", "#F7F5FA", "#AFA6BE", "#8255D9", "#54348F", "#3B2A57", "#27222F"], fonts: ["Funnel Sans"], sourcePage: 152, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 5, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-am", code: "AM", name: "Desert Dusk Horizon", palette: ["#F3C79C", "#B56C68", "#5D3156", "#251225", "#F28A4B", "#2B1009", "#1B0710", "#F8B06C"], fonts: ["Newsreader"], sourcePage: 156, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 6, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-an", code: "AN", name: "Polar Topography Glass", palette: ["#EDF8FA", "#C9E9EE", "#F8FCFC", "#A7D4DC", "#168AA2", "#0D5B6C", "#173941", "#63838A"], fonts: ["Geist"], sourcePage: 160, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 28, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 6, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-ao", code: "AO", name: "Amber Terminal Scan", palette: ["#050402", "#171005", "#352006", "#FFB020", "#B8A274", "#FFF3D5", "#FFD88A", "#FFFFFF"], fonts: ["IBM Plex Mono"], sourcePage: 164, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 10, radiusSource: "eco-radius-variable", radiusClass: "compact", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 28, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-ap", code: "AP", name: "Porcelain Cobalt Arches", palette: ["#F8FAFD", "#DCE8F7", "#C5D6EE", "#2959A8", "#1B3155", "#17366C", "#687A98", "#7EA4DF"], fonts: ["Playfair Display"], sourcePage: 168, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 22, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-aq", code: "AQ", name: "Sakura Ink Wash", palette: ["#FAEEF2", "#EECFD8", "#FFF8FA", "#D9AEBB", "#AD4169", "#762744", "#F66789", "#3C2830"], fonts: ["Playfair Display"], sourcePage: 172, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 9, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-ar", code: "AR", name: "Acid Blueprint", palette: ["#061035", "#102A75", "#173D9B", "#C7F348", "#00051A", "#0A1A4D", "#DDE7FF", "#9BA9CC"], fonts: ["IBM Plex Mono"], sourcePage: 176, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 12, radiusSource: "eco-radius-variable", radiusClass: "compact", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 29, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-as", code: "AS", name: "Espresso Copper Rings", palette: ["#120805", "#32180F", "#61341F", "#C98752", "#241207", "#C0A995", "#FFF5E8", "#000000"], fonts: ["Newsreader"], sourcePage: 180, mobileWidth: 390, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 24, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 7, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-at", code: "AT", name: "Ultraviolet Shards", palette: ["#05030A", "#180B2C", "#3A1761", "#B385FF", "#12051D", "#AFA2C2", "#FAF7FF", "#000000"], fonts: ["Funnel Sans"], sourcePage: 184, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 18, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 5, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-au", code: "AU", name: "Coral Lagoon Waves", palette: ["#DFF6F1", "#8FD6D2", "#FFF3EA", "#F29B84", "#158C88", "#0B5E5A", "#163B3B", "#F27F66"], fonts: ["Funnel Sans"], sourcePage: 188, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 28, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-av", code: "AV", name: "Night Transit Lines", palette: ["#020712", "#071B36", "#0C3650", "#58DEBC", "#041322", "#8CA6B5", "#F2FBFF", "#B5F6E5"], fonts: ["IBM Plex Mono"], sourcePage: 192, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 16, radiusSource: "eco-radius-variable", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 11, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-aw", code: "AW", name: "Paper Brutalist Blocks", palette: ["#F2EEE3", "#E33424", "#FFD42A", "#111111", "#5F5F5F", "#FFFFFF", "#000000", "#8A8F98"], fonts: ["IBM Plex Mono"], sourcePage: 196, mobileWidth: 390, classification: { backgroundType: "solid", surfaceRadius: 15, canonicalRadius: 0, radiusSource: "eco-radius-variable", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "hard-edge"] } },
  { id: "concept-ax", code: "AX", name: "Champagne Prism", palette: ["#FBF7ED", "#E6D4AE", "#FFFFFF", "#CDB278", "#9A6A24", "#67430E", "#40331F", "#807158"], fonts: ["Playfair Display"], sourcePage: 200, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 30, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 5, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-ay", code: "AY", name: "Cherry Nebula Smoke", palette: ["#12030A", "#3B0B20", "#7D1F40", "#F05A83", "#070105", "#240710", "#C59AA7", "#FFF4F7"], fonts: ["Funnel Sans"], sourcePage: 204, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 28, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 6, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-az", code: "AZ", name: "Slate Aurora Streaks", palette: ["#090D0D", "#1A2B2D", "#334C53", "#67DEAE", "#4EA7E8", "#0C1615", "#94AAA5", "#F1FAF8"], fonts: ["Geist"], sourcePage: 208, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 15, canonicalRadius: 26, radiusSource: "eco-radius-variable", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-ba", code: "BA", name: "Midnight Coral Mesh", palette: ["#05070D", "#15102A", "#5C2038", "#FF8AA8", "#0D0B17", "#FFF4F6", "#B9A1AA", "#000000"], fonts: ["Geist", "Space Grotesk"], sourcePage: 212, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-bb", code: "BB", name: "Alpine Moss Glass", palette: ["#EDF2E7", "#C6D5B7", "#F9F7EF", "#80956C", "#4E6B3A", "#26321E", "#66745C", "#000000"], fonts: ["Geist", "Newsreader"], sourcePage: 216, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 5, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bc", code: "BC", name: "Solar Flare Ledger", palette: ["#080504", "#2A0D07", "#7A210F", "#FF9A4D", "#FF7A1A", "#1A0800", "#FFF4E8", "#C7A78E"], fonts: ["IBM Plex Mono"], sourcePage: 220, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 8, canonicalRadius: 8, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "flat", backgroundBlur: false, shadow: false, directDecorCount: 4, decorDensity: "medium", visualFamily: "technical", visualTags: ["technical", "atmospheric"] } },
  { id: "concept-bd", code: "BD", name: "Ink Blue Editorial", palette: ["#F4F0E8", "#CCD7E3", "#FFFDF7", "#7189A3", "#284B73", "#1B2B3A", "#B85842", "#5B4630"], fonts: ["Source Sans 3", "Playfair Display"], sourcePage: 224, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-be", code: "BE", name: "Peach Orbital Mist", palette: ["#FFF1EA", "#F6C5B5", "#F7DDF0", "#C99AC4", "#D75E47", "#452923", "#8A675F", "#F6E6E1"], fonts: ["Geist", "Playfair Display"], sourcePage: 228, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bf", code: "BF", name: "Carbon Ice Circuit", palette: ["#03080B", "#08202B", "#0A5360", "#04111A", "#65E6FF", "#F1FCFF", "#90ADB7", "#D5F6FF"], fonts: ["Geist", "IBM Plex Mono"], sourcePage: 232, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 8, canonicalRadius: 8, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "flat", backgroundBlur: false, shadow: false, directDecorCount: 14, decorDensity: "dense", visualFamily: "technical", visualTags: ["technical", "atmospheric"] } },
  { id: "concept-bg", code: "BG", name: "Lavender Silk Paper", palette: ["#F7F2FF", "#D7C7EA", "#FFFDFE", "#AB8CC5", "#7A4BB8", "#352743", "#5B4630", "#EFE8F7"], fonts: ["Geist", "Playfair Display"], sourcePage: 236, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bh", code: "BH", name: "Cobalt Citrus Grid", palette: ["#050B2A", "#0D2672", "#1741A5", "#061038", "#D7FF4F", "#0D1700", "#07164A", "#F6F8FF"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 240, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 14, decorDensity: "dense", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-bi", code: "BI", name: "Saffron Dune Glass", palette: ["#F9EBD0", "#E6C07A", "#FFF8E8", "#B98135", "#A66200", "#3A2A14", "#E44C3A", "#F2E2BF"], fonts: ["Geist", "Newsreader"], sourcePage: 244, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bj", code: "BJ", name: "Emerald Borealis", palette: ["#020A08", "#063626", "#123E55", "#071016", "#63E6A4", "#91B9A7", "#F2FFF8", "#000000"], fonts: ["Geist", "Space Grotesk"], sourcePage: 248, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-bk", code: "BK", name: "Monochrome Film Grain", palette: ["#050505", "#1B1C1D", "#34383B", "#FFFFFF", "#0B0C0D", "#111315", "#F0F0EA", "#F6F6F2"], fonts: ["Geist", "IBM Plex Mono"], sourcePage: 252, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 14, canonicalRadius: 14, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 11, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "technical", "atmospheric"] } },
  { id: "concept-bl", code: "BL", name: "Rose Quartz Shell", palette: ["#FFF4F7", "#E7C5D0", "#B98EA0", "#9A3C5C", "#402530", "#F3E5EB", "#7E6570", "#000000"], fonts: ["Geist", "Playfair Display"], sourcePage: 256, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bm", code: "BM", name: "Teal Blueprint", palette: ["#020B0D", "#06313A", "#0B6470", "#3FE0D0", "#031117", "#F0FFFD", "#8FB9B6", "#A7FFF4"], fonts: ["IBM Plex Mono"], sourcePage: 260, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 8, canonicalRadius: 8, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "flat", backgroundBlur: false, shadow: false, directDecorCount: 14, decorDensity: "dense", visualFamily: "technical", visualTags: ["technical", "atmospheric"] } },
  { id: "concept-bn", code: "BN", name: "Wine Velvet Halo", palette: ["#12040A", "#3A0D1E", "#6D223B", "#D890A8", "#FFF4F7", "#C49AA8", "#000000", "#FFFFFF"], fonts: ["Geist", "Newsreader"], sourcePage: 264, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bo", code: "BO", name: "Arctic Sunrise", palette: ["#ECF7FA", "#BADDE7", "#FFF3E9", "#91C4D2", "#E36A5C", "#18333C", "#617E86", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 268, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "atmospheric", visualTags: ["dimensional", "atmospheric"] } },
  { id: "concept-bp", code: "BP", name: "Obsidian Gold Foil", palette: ["#030303", "#171009", "#3B2B13", "#D7A84B", "#FFF9E8", "#BBAA82", "#5B4630", "#FFFFFF"], fonts: ["Newsreader", "Playfair Display"], sourcePage: 272, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bq", code: "BQ", name: "Mint Porcelain Flow", palette: ["#EAF8F4", "#BFE3D9", "#FFFDF9", "#86B9AD", "#188A78", "#193A34", "#67847D", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 276, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "atmospheric", visualTags: ["dimensional", "atmospheric"] } },
  { id: "concept-br", code: "BR", name: "Rust Industrial", palette: ["#0C0806", "#32170E", "#66321B", "#D86432", "#1C0800", "#FFF3EB", "#B79683", "#000000"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 280, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-bs", code: "BS", name: "Plum Plasma Bloom", palette: ["#08040F", "#2A0B3C", "#5A1C67", "#100617", "#D86CFF", "#FCF4FF", "#B8A0C5", "#000000"], fonts: ["Geist", "Space Grotesk"], sourcePage: 284, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-bt", code: "BT", name: "Oceanic Hologram", palette: ["#020915", "#06304A", "#145B72", "#06101F", "#56E0FF", "#F1FBFF", "#92AFC0", "#000000"], fonts: ["Geist", "Space Grotesk"], sourcePage: 288, mobileWidth: 360, classification: { backgroundType: "linear-gradient", surfaceRadius: 14, canonicalRadius: 14, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-bu", code: "BU", name: "Cream Red Swiss", palette: ["#F4F0E6", "#FFFDF7", "#E8D9B8", "#C9C2B4", "#E23D2D", "#2446A8", "#1A1A1A", "#66615A"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 292, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-bv", code: "BV", name: "Graphite Aqua Pulse", palette: ["#080B0D", "#1A2328", "#243E48", "#5FE3D1", "#041715", "#F1FCFA", "#96AAA8", "#111A1E"], fonts: ["Geist", "IBM Plex Mono"], sourcePage: 296, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 8, canonicalRadius: 8, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "flat", backgroundBlur: false, shadow: false, directDecorCount: 3, decorDensity: "light", visualFamily: "technical", visualTags: ["technical", "atmospheric"] } },
  { id: "concept-bw", code: "BW", name: "Terracotta Botanical", palette: ["#F5E7D8", "#D7B49B", "#F9F2E9", "#9E846D", "#A65336", "#3E2A22", "#5B4630", "#7B665C"], fonts: ["Geist", "Newsreader"], sourcePage: 300, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 6, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-bx", code: "BX", name: "Silver Blue Morph", palette: ["#EFF2F6", "#C7D3E3", "#F8FAFC", "#9AAAC0", "#4A6FA8", "#253448", "#6D7C91", "#A685D8"], fonts: ["Geist", "Space Grotesk"], sourcePage: 304, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 14, canonicalRadius: 14, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-by", code: "BY", name: "Acid Charcoal Tech", palette: ["#050606", "#171A1A", "#2A3331", "#C8F436", "#101700", "#6DE5FF", "#F7FAF4", "#A1AAA4"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 308, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 14, decorDensity: "dense", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-bz", code: "BZ", name: "Coral Paper Cut", palette: ["#FFF0E8", "#F5C3AE", "#FFF9F3", "#D9947F", "#D9584B", "#452923", "#F3B56D", "#86675E"], fonts: ["Geist", "Newsreader"], sourcePage: 312, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-ca", code: "CA", name: "Midnight Sakura", palette: ["#0E030A", "#350B22", "#5F1837", "#F06C9B", "#FFF4F8", "#C49AAA", "#5B2630", "#210A17"], fonts: ["Geist", "Playfair Display"], sourcePage: 316, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 6, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-cb", code: "CB", name: "Sky Ceramic Arch", palette: ["#EFF8FD", "#C4E4F1", "#FFFDFB", "#8FB8CC", "#376EA8", "#1C3853", "#668096", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 320, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "atmospheric", visualTags: ["dimensional", "atmospheric"] } },
  { id: "concept-cc", code: "CC", name: "Olive Linen Field", palette: ["#F1EBD8", "#C8C79D", "#FAF7EE", "#9A9A6B", "#68723A", "#30351F", "#5B4630", "#B1844E"], fonts: ["Geist", "Newsreader"], sourcePage: 324, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 5, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-cd", code: "CD", name: "Crimson Data Tunnel", palette: ["#080307", "#2D0810", "#650E20", "#FF4D5A", "#230307", "#FFF3F5", "#C3929A", "#1A0710"], fonts: ["IBM Plex Mono"], sourcePage: 328, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 8, canonicalRadius: 8, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "flat", backgroundBlur: false, shadow: false, directDecorCount: 5, decorDensity: "medium", visualFamily: "technical", visualTags: ["technical", "atmospheric"] } },
  { id: "concept-ce", code: "CE", name: "Lilac Ice Prism", palette: ["#F4F1FF", "#D5D9F4", "#F8FDFF", "#A6B7D6", "#7259C7", "#302A4D", "#ECEAF6", "#746E8D"], fonts: ["Geist", "Space Grotesk"], sourcePage: 332, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 14, canonicalRadius: 14, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-cf", code: "CF", name: "Amber Noir Cinema", palette: ["#050403", "#1E140A", "#49301A", "#F1B24A", "#FFF7E8", "#BBA587", "#5B4630", "#FFFFFF"], fonts: ["Newsreader", "Playfair Display"], sourcePage: 336, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-cg", code: "CG", name: "Seaglass Tide", palette: ["#ECFAF8", "#B7E3DC", "#FFFDF8", "#7EB8B1", "#178C9C", "#173B40", "#67858A", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 340, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 18, canonicalRadius: 18, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "atmospheric", visualTags: ["dimensional", "atmospheric"] } },
  { id: "concept-ch", code: "CH", name: "Warm Concrete Signal", palette: ["#E8E2D8", "#C9C1B5", "#F5F1E9", "#A89D90", "#D96B32", "#2E647D", "#1D1D1D", "#6A6762"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 344, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 14, decorDensity: "dense", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-ci", code: "CI", name: "Electric Cyan Matrix", palette: ["#020507", "#001A24", "#063C49", "#00E5FF", "#020C11", "#F0FCFF", "#87ABB3", "#7B61FF"], fonts: ["IBM Plex Mono"], sourcePage: 348, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 8, canonicalRadius: 8, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "flat", backgroundBlur: false, shadow: false, directDecorCount: 14, decorDensity: "dense", visualFamily: "technical", visualTags: ["technical", "atmospheric"] } },
  { id: "concept-cj", code: "CJ", name: "Burgundy Pearl", palette: ["#10040A", "#3A1022", "#65273E", "#D99BB1", "#FFF4F7", "#C3A0AC", "#000000", "#FFFFFF"], fonts: ["Geist", "Playfair Display"], sourcePage: 352, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 14, canonicalRadius: 14, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric"] } },
  { id: "concept-ck", code: "CK", name: "Butter Cobalt Collage", palette: ["#FFF5C9", "#F6D66D", "#F9F5E7", "#D6B84D", "#1F2B55", "#2855B8", "#E64B3C", "#F4E8BE"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 356, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-cl", code: "CL", name: "Jade Bronze Temple", palette: ["#04110D", "#0C3528", "#2B4C38", "#65C5A3", "#052018", "#F0FFF9", "#91B5A7", "#3A2B1F"], fonts: ["Geist", "Playfair Display"], sourcePage: 360, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 12, canonicalRadius: 12, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "compact", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric"] } },
  { id: "concept-cm", code: "CM", name: "Moonstone Lavender", palette: ["#F1F2F4", "#D6D2E4", "#FAFAFC", "#A9AFBF", "#7764A8", "#313144", "#747489", "#000000"], fonts: ["Geist", "Space Grotesk"], sourcePage: 364, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 14, canonicalRadius: 14, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-cn", code: "CN", name: "Scarlet Sandstorm", palette: ["#100503", "#43110C", "#7D2B19", "#FF664D", "#250600", "#FFF3EF", "#C39A8E", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 368, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 4, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-co", code: "CO", name: "Aqua Blacklight", palette: ["#020508", "#041B1A", "#22113C", "#58F0D0", "#F0FFFB", "#8FB3AA", "#FFFFFF", "#B55CFF"], fonts: ["Geist", "Space Grotesk"], sourcePage: 372, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 2, decorDensity: "light", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-cp", code: "CP", name: "Ivory Ink Geometry", palette: ["#F8F4E9", "#E8E0D1", "#FFFDF8", "#BDB3A2", "#191919", "#F1EBDF", "#64605A", "#000000"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 376, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 3, canonicalRadius: 3, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 3, decorDensity: "light", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge"] } },
  { id: "concept-cq", code: "CQ", name: "Moss Neon Biome", palette: ["#050A05", "#172513", "#314326", "#B5F55A", "#142000", "#F7FFF1", "#A1B495", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 380, mobileWidth: 393, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 6, decorDensity: "medium", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-cr", code: "CR", name: "Deep Space Magenta", palette: ["#03030B", "#100A31", "#3A1255", "#FF5EC4", "#090615", "#24001A", "#FFF2FC", "#B59BB9"], fonts: ["Geist", "Space Grotesk"], sourcePage: 384, mobileWidth: 430, classification: { backgroundType: "linear-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 11, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric"] } },
  { id: "concept-cs", code: "CS", name: "Champagne Ocean", palette: ["#9A6A24", "#553A15", "#40331F", "#807158", "#F2ECDE", "#2B2922", "#FFFDF7", "#000000"], fonts: ["Geist", "Playfair Display"], sourcePage: 388, mobileWidth: 430, classification: { backgroundType: "mesh-gradient", surfaceRadius: 24, canonicalRadius: 24, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 14, decorDensity: "dense", visualFamily: "editorial", visualTags: ["dimensional", "editorial", "atmospheric", "mesh"] } },
  { id: "concept-ct", code: "CT", name: "Slate Tangerine Map", palette: ["#FF8A3D", "#231000", "#0B1216", "#111B20", "#9CABB0", "#F5FAFC", "#FFFFFF", "#000000"], fonts: ["IBM Plex Mono"], sourcePage: 392, mobileWidth: 393, classification: { backgroundType: "mesh-gradient", surfaceRadius: 2, canonicalRadius: 2, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 16, decorDensity: "dense", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge", "mesh"] } },
  { id: "concept-cu", code: "CU", name: "Polar Red Monolith", palette: ["#1A1A1A", "#1B2529", "#E84545", "#376EA8", "#EDF2F3", "#66757A", "#FFFFFF", "#000000"], fonts: ["IBM Plex Mono", "Archivo Narrow"], sourcePage: 396, mobileWidth: 393, classification: { backgroundType: "mesh-gradient", surfaceRadius: 0, canonicalRadius: 0, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 13, decorDensity: "dense", visualFamily: "hard-edge", visualTags: ["dimensional", "technical", "atmospheric", "hard-edge", "mesh"] } },
  { id: "concept-cv", code: "CV", name: "Ultramarine Frost", palette: ["#7CA6FF", "#000718", "#050F29", "#08183D", "#FFFFFF", "#F2F6FF", "#9DAED0", "#000000"], fonts: ["Geist", "Funnel Sans"], sourcePage: 400, mobileWidth: 360, classification: { backgroundType: "mesh-gradient", surfaceRadius: 20, canonicalRadius: 20, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 16, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric", "mesh"] } },
  { id: "concept-cw", code: "CW", name: "Cocoa Mint Orbit", palette: ["#72D6B1", "#050201", "#120C09", "#062018", "#1D130E", "#B5A091", "#FFF6EE", "#FFFFFF"], fonts: ["Geist", "Newsreader"], sourcePage: 404, mobileWidth: 430, classification: { backgroundType: "mesh-gradient", surfaceRadius: 24, canonicalRadius: 24, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 15, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "editorial", "atmospheric", "mesh"] } },
  { id: "concept-cx", code: "CX", name: "Pearl Acid Bloom", palette: ["#657A31", "#192000", "#A7D93B", "#505846", "#FFFFFF", "#9B6DFF", "#ECEDE5", "#2C3025"], fonts: ["Geist", "Space Grotesk"], sourcePage: 408, mobileWidth: 393, classification: { backgroundType: "mesh-gradient", surfaceRadius: 16, canonicalRadius: 16, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "rounded", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 15, decorDensity: "dense", visualFamily: "atmospheric", visualTags: ["dimensional", "atmospheric", "mesh"] } },
  { id: "concept-cy", code: "CY", name: "Night Gold Cartography", palette: ["#D8B15A", "#06101A", "#1B1200", "#000000", "#66A7B8", "#FFF8E8", "#A9A88F", "#FFFFFF"], fonts: ["IBM Plex Mono", "Playfair Display"], sourcePage: 412, mobileWidth: 393, classification: { backgroundType: "mesh-gradient", surfaceRadius: 4, canonicalRadius: 4, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "square", effectClass: "shadow", backgroundBlur: false, shadow: true, directDecorCount: 18, decorDensity: "dense", visualFamily: "hard-edge", visualTags: ["dimensional", "editorial", "technical", "atmospheric", "hard-edge", "mesh"] } },
  { id: "concept-cz", code: "CZ", name: "Aurora Obsidian Veil", palette: ["#63F0E0", "#040B0E", "#031816", "#D45CFF", "#FFFFFF", "#000000", "#F1FFFC", "#96B2AC"], fonts: ["Geist", "Space Grotesk"], sourcePage: 416, mobileWidth: 430, classification: { backgroundType: "mesh-gradient", surfaceRadius: 22, canonicalRadius: 22, radiusSource: "matched-rezeis-reiwa-sidebar", radiusClass: "pillowy", effectClass: "blur-shadow", backgroundBlur: true, shadow: true, directDecorCount: 15, decorDensity: "dense", visualFamily: "glass-dimensional", visualTags: ["glass", "dimensional", "atmospheric", "mesh"] } },
] as const satisfies readonly ConceptPresetDescriptor[]

type ConceptSourceStyleTuple = readonly [
  background: string | null,
  surface: HexColor,
  card: HexColor,
  accent: HexColor,
  foreground: HexColor,
  mutedForeground: HexColor,
  border: HexColor,
  headingFont: string,
  bodyFont: string,
  dataFont: string,
]

/**
 * Read-only semantic snapshot extracted from the 104 Rezeis dashboard frames
 * in subscription.pen. Keep this compact table aligned with CONCEPT_PRESETS.
 */
const CONCEPT_SOURCE_STYLE_TUPLES = {
  A: ["radial-gradient(ellipse 50% 37% at 16% 5%, #351411 0%, #090706 100%)", "#171311CC", "#0F0D0C", "#C92F26", "#F8F5F1", "#756964", "#514A46", "Funnel Sans", "Geist", "IBM Plex Mono"],
  B: ["radial-gradient(ellipse 52.5% 37.5% at 75% 8%, #26352D 0%, #070A09 100%)", "#0B0D0C", "#0B0D0C", "#F0643B", "#F3F0E8", "#969A91", "#2B302B", "Archivo", "Geist", "Archivo"],
  C: ["radial-gradient(ellipse 57.5% 44% at 76% 8%, #3A2449 0%, #17111E 45%, #09080D 100%)", "#0D0B12", "#0D0B12", "#E6FF58", "#F5F2F7", "#9D96A7", "#302B39", "Archivo Narrow", "Geist", "Archivo Narrow"],
  D: ["linear-gradient(24.116deg, #E6DBFF 11.954%, #CDBAF7 88.046%)", "#09080B", "#09080B", "#4B27B3", "#09080B", "#A6A0AE", "#BBA9E5", "Funnel Sans", "Geist", "Funnel Sans"],
  E: ["radial-gradient(ellipse 52.5% 41% at 72% 2%, #25113B 0%, #0A0812 62%, #07060D 100%)", "#0A0812", "#0A0812", "#A855F7", "#F8F6FB", "#8F8799", "#FFFFFF12", "Nunito", "Nunito", "Nunito"],
  F: ["#0A0812", "#0A0812", "#0A0812", "#A855F7", "#F7F5F8", "#77717F", "#FFFFFF14", "Nunito", "Nunito", "Nunito"],
  G: ["linear-gradient(-146.091deg, #020713 8.437%, #071123 45.844%, #15102B 71.613%, #03050B 91.563%)", "#0D1425D9", "#0D1425D9", "#66F3FF", "#F8FBFF", "#AEB8CC", "#FFFFFF22", "Funnel Sans", "Geist", "Funnel Sans"],
  H: ["radial-gradient(ellipse 57.5% 45% at 72% 6%, #D7FCFF 0%, #E5DEFF 35%, #F6F8FF 68%, #EAF0F8 100%)", "#F8FAFEF2", "#F8FAFEF2", "#6D5DE7", "#172033", "#667085", "#FFFFFFF2", "Nunito", "Nunito", "Nunito"],
  I: ["linear-gradient(-24.116deg, #FBFCF7 11.954%, #EDF4EE 50%, #E4EEEA 88.046%)", "#FFFFFF00", "#FFFFFF00", "#2F8F73", "#17352C", "#60736B", "#B8CAC1", "Geist", "Geist", "Geist"],
  J: ["linear-gradient(-19.26deg, #F8F9FF 10.522%, #EEF1FF 56.317%, #FFF5EE 89.478%)", "#F8F9FD", "#F8F9FD", "#2667FF", "#121828", "#5D6475", "#DCE2F2", "Nunito", "Nunito", "Nunito"],
  K: ["radial-gradient(ellipse 60% 47.5% at 76% 2%, #707788 0%, #3A3742 25%, #18181C 58%, #0D0D0F 100%)", "#0F1014E8", "#0F1014E8", "#BFC3CB", "#F8FBFF", "#AEB8CC", "#FFFFFF2E", "Funnel Sans", "Geist", "Funnel Sans"],
  L: ["radial-gradient(ellipse 62.5% 46% at 72% 4%, #D8C1B3 0%, #C8D3C2 34%, #F1ECE4 68%, #E7E0D6 100%)", "#FFFDF8B8", "#FFFDF8B8", "#4C5A22", "#242920", "#6D7168", "#FFFFFFE8", "Nunito", "Nunito", "Nunito"],
  M: ["radial-gradient(ellipse 64% 49% at 74% 4%, #AF65C2 0%, #463B94 22%, #1B1955 50%, #020209 100%)", "#080718CC", "#080718CC", "#AF65C2", "#F8FBFF", "#AEB8CC", "#CDBBF05C", "Funnel Sans", "Geist", "Funnel Sans"],
  N: ["radial-gradient(ellipse 62% 47.5% at 78% 3%, #3D9FBC 0%, #064865 27%, #033D58 53%, #030405 100%)", "#020A0FE8", "#020A0FE8", "#72D4EC", "#F8FBFF", "#AEB8CC", "#72D4EC4F", "Funnel Sans", "Geist", "Funnel Sans"],
  O: ["radial-gradient(ellipse 65% 49% at 78% 3%, #A64B1C 0%, #4D250C 26%, #1B0D08 56%, #030202 100%)", "#080403E8", "#080403E8", "#F25A25", "#F8FBFF", "#AEB8CC", "#A64B1C61", "Funnel Sans", "Geist", "Funnel Sans"],
  P: ["radial-gradient(ellipse 66% 50% at 76% 3%, #F66789 0%, #B1393E 23%, #5D1D21 52%, #030102 100%)", "#F6678915", "#F6678915", "#F66789", "#F8FBFF", "#AEB8CC", "#FDEDEF61", "Funnel Sans", "Geist", "Funnel Sans"],
  Q: ["linear-gradient(-143.129deg, #050706 7.048%, #10170B 37.974%, #223016 65.463%, #070A06 92.952%)", "#070A07D9", "#070A07D9", "#B8F34A", "#F4F8EE", "#9AA88E", "#B8F34A38", "Funnel Sans", "Geist", "Funnel Sans"],
  R: ["linear-gradient(-139.16deg, #F3E9DA 9.199%, #E7CDBC 40.208%, #F8F0E6 66.32%, #ECDACB 90.801%)", "#F8EDE0D6", "#F8EDE0D6", "#A85D3F", "#321F19", "#7B6258", "#A85D3F32", "Nunito", "Nunito", "Nunito"],
  S: ["linear-gradient(-133.165deg, #EFF8F3 7.606%, #D9EEE4 36.434%, #F6FBF8 66.958%, #CDE8DD 92.394%)", "#FFFFFF8F", "#FFFFFF8F", "#5BB8A8", "#153B37", "#5D7B73", "#177D732E", "Nunito", "Nunito", "Nunito"],
  T: ["linear-gradient(-146.091deg, #050714 6.63%, #111943 36.122%, #2438A8 65.613%, #080B22 93.37%)", "#070A1DCF", "#070A1DCF", "#526CFF", "#F3F5FF", "#9AA7D8", "#526CFF45", "Funnel Sans", "Geist", "Funnel Sans"],
  U: ["linear-gradient(-139.16deg, #041312 7.425%, #0C3733 39.782%, #17675D 67.03%, #061B19 92.575%)", "#061A18D6", "#061A18D6", "#C4774A", "#F2F8F5", "#9ABBB3", "#C4774A3D", "Funnel Sans", "Geist", "Funnel Sans"],
  V: ["linear-gradient(-137.168deg, #F4F5F4 9.306%, #FFFFFF 37.792%, #E4E6E5 64.65%, #F7F8F7 90.694%)", "#F8F9F8A8", "#F8F9F8A8", "#272A29", "#161817", "#6E7471", "#272A2929", "Nunito", "Nunito", "Nunito"],
  W: ["linear-gradient(-146.091deg, #030504 6.63%, #0A1306 45.663%, #1C2C0F 72.552%, #050805 93.37%)", "#070B06B8", "#070B06B8", "#C9FF52", "#F5F8F3", "#96A38F", "#C9FF5242", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  X: ["linear-gradient(-139.16deg, #F7EADB 7.425%, #EBC9AF 45.743%, #F9F1E7 72.139%, #DFB596 92.575%)", "#F7E8D9B8", "#F7E8D9B8", "#A84B2E", "#3B1F17", "#86675B", "#A84B2E36", "Newsreader", "Newsreader", "Newsreader"],
  Y: ["linear-gradient(-149.042deg, #020814 6.092%, #062741 45.609%, #0B4B6E 71.954%, #020B16 93.908%)", "#03131FC4", "#03131FC4", "#46D9FF", "#F2FAFF", "#91B7CE", "#46D9FF42", "Geist", "Geist", "Geist"],
  Z: ["linear-gradient(-133.165deg, #FFF4F6 7.606%, #F2D3DC 43.217%, #FFF9F7 68.653%, #E7C1CF 92.394%)", "#F9EDF2B8", "#F9EDF2B8", "#B9567A", "#452333", "#876476", "#B9567A34", "Playfair Display", "Playfair Display", "Playfair Display"],
  AA: ["linear-gradient(-146.091deg, #01050A 6.63%, #071725 44.796%, #123448 72.552%, #02070D 93.37%)", "#020B11CC", "#020B11CC", "#8CE7FF", "#F2FAFF", "#8DA9BB", "#8CE7FF42", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AB: ["linear-gradient(-141.147deg, #FFF1E6 7.262%, #F9B99F 43.162%, #FFF8F1 68.805%, #F39B7F 92.738%)", "#FCECE4B8", "#FCECE4B8", "#E4573D", "#4B241C", "#8B6257", "#E4573D36", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AC: ["linear-gradient(-147.076deg, #08030D 6.464%, #24102F 43.905%, #48205B 70.026%, #0B0411 93.536%)", "#100717C4", "#100717C4", "#D48CFF", "#FAF4FF", "#B49AC1", "#D48CFF42", "Geist", "Geist", "Geist"],
  AD: ["linear-gradient(-143.129deg, #031008 7.048%, #0A3521 43.128%, #176443 69.758%, #04140C 92.952%)", "#05160FC2", "#05160FC2", "#63E6A4", "#F3FFF8", "#9FC2AE", "#63E6A43E", "Newsreader", "Newsreader", "Newsreader"],
  AE: ["linear-gradient(-143.129deg, #050605 7.048%, #151817 45.705%, #303432 70.617%, #080908 92.952%)", "#080A09C7", "#080A09C7", "#F1F3F2", "#F6F7F6", "#969A98", "#FFFFFF32", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AF: ["linear-gradient(-146.091deg, #020A0D 6.63%, #083643 41.326%, #463062 69.083%, #061319 93.37%)", "#04131BC4", "#04131BC4", "#67F0DB", "#F3FFFD", "#9DC5C2", "#67F0DB42", "Geist", "Geist", "Geist"],
  AG: ["linear-gradient(-146.091deg, #030303 6.63%, #130505 46.53%, #360B09 72.552%, #050303 93.37%)", "#070202D1", "#090403C5", "#FF4D44", "#FFF4F2", "#A58E8A", "#FF4D443D", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AH: ["linear-gradient(-133.165deg, #F7EBCB 7.606%, #EED895 43.217%, #FFF9E9 68.653%, #E5C56A 92.394%)", "#F8ECCDDE", "#FFFDF4F0", "#A96700", "#342713", "#7C6A4F", "#A9670030", "Newsreader", "Newsreader", "Newsreader"],
  AI: ["linear-gradient(-151.002deg, #01080D 5.666%, #032A38 41.133%, #07596B 69.507%, #010B12 94.334%)", "#021219C7", "#031820DE", "#40F0D9", "#EEFFFD", "#88BDB8", "#40F0D93B", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AJ: ["#F3EFE5", "#F6F1E8E0", "#FFFDF7F0", "#D94332", "#171717", "#66625B", "#17171729", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AK: ["linear-gradient(-137.168deg, #E9E3D0 7.537%, #B8C39B 43.206%, #F1EDE0 68.684%, #8FA06C 92.463%)", "#EEF0DFC9", "#EEF0DFC9", "#52652A", "#2C3421", "#6F765D", "#52652A30", "Newsreader", "Newsreader", "Newsreader"],
  AL: ["linear-gradient(-139.16deg, #E8E9ED 7.425%, #CFC5DD 39.782%, #F7F5FA 65.327%, #AFA6BE 92.575%)", "#F2EDF9A8", "#F2EDF9A8", "#8255D9", "#27222F", "#746B7D", "#8255D936", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AM: ["linear-gradient(180deg, #F3C79C -10%, #B56C68 35.6%, #5D3156 74%, #251225 110%)", "#201019B8", "#201019B8", "#F28A4B", "#FFF7EF", "#D6B7AD", "#F28A4B3D", "Newsreader", "Newsreader", "Newsreader"],
  AN: ["linear-gradient(-135.169deg, #EDF8FA 7.597%, #C9E9EE 41.519%, #F8FCFC 66.961%, #A7D4DC 92.403%)", "#EFF9F9A8", "#EFF9F9A8", "#168AA2", "#173941", "#63838A", "#168AA232", "Geist", "Geist", "Geist"],
  AO: ["linear-gradient(-146.091deg, #050402 6.63%, #171005 46.53%, #352006 72.552%, #070502 93.37%)", "#090602C0", "#090602C0", "#FFB020", "#FFF3D5", "#B8A274", "#FFB0203D", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AP: ["linear-gradient(-136.169deg, #F8FAFD 7.574%, #DCE8F7 41.515%, #FFFFFF 66.971%, #C5D6EE 92.426%)", "#F3F6FCA6", "#F3F6FCA6", "#2959A8", "#1B3155", "#687A98", "#2959A831", "Playfair Display", "Playfair Display", "Playfair Display"],
  AQ: ["linear-gradient(-138.165deg, #FAEEF2 7.487%, #EECFD8 41.497%, #FFF8FA 67.005%, #D9AEBB 92.513%)", "#F8EDF1A8", "#F8EDF1A8", "#AD4169", "#3C2830", "#806771", "#AD416932", "Playfair Display", "Playfair Display", "Playfair Display"],
  AR: ["linear-gradient(-146.091deg, #061035 6.63%, #102A75 44.796%, #173D9B 70.818%, #07102F 93.37%)", "#050D29C0", "#050D29C0", "#C7F348", "#F4F8FF", "#9BA9CC", "#C7F3483B", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AS: ["linear-gradient(-143.129deg, #120805 7.048%, #32180F 43.128%, #61341F 68.899%, #160A06 92.952%)", "#110806C4", "#110806C4", "#C98752", "#FFF5E8", "#C0A995", "#C987523B", "Newsreader", "Newsreader", "Newsreader"],
  AT: ["linear-gradient(-146.091deg, #05030A 6.63%, #180B2C 41.326%, #3A1761 69.083%, #08040E 93.37%)", "#0C0618C2", "#0C0618C2", "#B385FF", "#FAF7FF", "#AFA2C2", "#B385FF3B", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AU: ["linear-gradient(-136.169deg, #DFF6F1 7.574%, #8FD6D2 39.818%, #FFF3EA 66.971%, #F29B84 92.426%)", "#F1FAF8A5", "#F1FAF8A5", "#158C88", "#163B3B", "#5F7E7D", "#158C8831", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AV: ["linear-gradient(-149.042deg, #020712 6.092%, #071B36 42.975%, #0C3650 69.319%, #030914 93.908%)", "#030D18C0", "#030D18C0", "#58DEBC", "#F2FBFF", "#8CA6B5", "#58DEBC3A", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AW: ["#F2EEE3", "#F5F1E8E8", "#F5F1E8E8", "#E33424", "#111111", "#5F5F5F", "#111111", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  AX: ["linear-gradient(-135.169deg, #FBF7ED 7.597%, #E6D4AE 41.519%, #FFFFFF 65.265%, #CDB278 92.403%)", "#F8F2E5A8", "#F8F2E5A8", "#9A6A24", "#40331F", "#807158", "#9A6A2430", "Playfair Display", "Playfair Display", "Playfair Display"],
  AY: ["linear-gradient(-146.091deg, #12030A 6.63%, #3B0B20 41.326%, #7D1F40 69.083%, #16040C 93.37%)", "#17070FC0", "#17070FC0", "#F05A83", "#FFF4F7", "#C59AA7", "#F05A833B", "Funnel Sans", "Funnel Sans", "Funnel Sans"],
  AZ: ["linear-gradient(-146.091deg, #090D0D 6.63%, #1A2B2D 43.061%, #334C53 69.083%, #0C1112 93.37%)", "#08100FC0", "#08100FC0", "#67DEAE", "#F1FAF8", "#94AAA5", "#67DEAE3A", "Geist", "Geist", "Geist"],
  BA: ["linear-gradient(-146.091deg, #05070D 6.63%, #15102A 41.326%, #5C2038 69.083%, #0B0610 93.37%)", "#0D0B17D1", "#151224D9", "#FF6B7A", "#FFF4F6", "#B9A1AA", "#FF8AA83D", "Space Grotesk", "Geist", "Space Grotesk"],
  BB: ["linear-gradient(-146.091deg, #EDF2E7 6.63%, #C6D5B7 41.326%, #F9F7EF 69.083%, #80956C 93.37%)", "#E7EEDFDC", "#F9FBF1E6", "#4E6B3A", "#26321E", "#66745C", "#4E6B3A35", "Newsreader", "Geist", "Newsreader"],
  BC: ["linear-gradient(-146.091deg, #080504 6.63%, #2A0D07 41.326%, #7A210F 69.083%, #100503 93.37%)", "#100704D9", "#1A0B06E6", "#FF7A1A", "#FFF4E8", "#C7A78E", "#FF9A4D42", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  BD: ["linear-gradient(-146.091deg, #F4F0E8 6.63%, #CCD7E3 41.326%, #FFFDF7 69.083%, #7189A3 93.37%)", "#E9EEF2E3", "#FFFDF4EB", "#284B73", "#1B2B3A", "#657787", "#284B7338", "Playfair Display", "Source Sans 3", "Playfair Display"],
  BE: ["linear-gradient(-146.091deg, #FFF1EA 6.63%, #F6C5B5 41.326%, #F7DDF0 69.083%, #C99AC4 93.37%)", "#F6E6E1DE", "#FFF8F3E8", "#D75E47", "#452923", "#8A675F", "#D75E4735", "Playfair Display", "Geist", "Playfair Display"],
  BF: ["linear-gradient(-146.091deg, #03080B 6.63%, #08202B 41.326%, #0A5360 69.083%, #040A0E 93.37%)", "#04111ADB", "#071923E3", "#65E6FF", "#F1FCFF", "#90ADB7", "#65E6FF3B", "IBM Plex Mono", "Geist", "IBM Plex Mono"],
  BG: ["linear-gradient(-146.091deg, #F7F2FF 6.63%, #D7C7EA 41.326%, #FFFDFE 69.083%, #AB8CC5 93.37%)", "#EFE8F7DC", "#FFFFFFDE", "#7A4BB8", "#352743", "#766681", "#7A4BB836", "Playfair Display", "Geist", "Playfair Display"],
  BH: ["linear-gradient(-146.091deg, #050B2A 6.63%, #0D2672 41.326%, #1741A5 69.083%, #061038 93.37%)", "#050F36DA", "#07164AE0", "#D7FF4F", "#F6F8FF", "#A5B2D2", "#D7FF4F3B", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  BI: ["linear-gradient(-146.091deg, #F9EBD0 6.63%, #E6C07A 41.326%, #FFF8E8 69.083%, #B98135 93.37%)", "#F2E2BFD6", "#FFF9EBDC", "#A66200", "#3A2A14", "#7A6848", "#A6620035", "Newsreader", "Geist", "Newsreader"],
  BJ: ["linear-gradient(-146.091deg, #020A08 6.63%, #063626 41.326%, #123E55 69.083%, #071016 93.37%)", "#03110DDA", "#051B15DE", "#63E6A4", "#F2FFF8", "#91B9A7", "#63E6A43B", "Space Grotesk", "Geist", "Space Grotesk"],
  BK: ["linear-gradient(-146.091deg, #050505 6.63%, #1B1C1D 41.326%, #34383B 69.083%, #080808 93.37%)", "#0B0C0DDD", "#111315E5", "#F0F0EA", "#F6F6F2", "#A4A5A3", "#FFFFFF32", "IBM Plex Mono", "Geist", "IBM Plex Mono"],
  BL: ["linear-gradient(-146.091deg, #FFF4F7 6.63%, #E7C5D0 41.326%, #FFFDFE 69.083%, #B98EA0 93.37%)", "#F3E5EBD9", "#FFF9FADD", "#9A3C5C", "#402530", "#7E6570", "#9A3C5C35", "Playfair Display", "Geist", "Playfair Display"],
  BM: ["linear-gradient(-146.091deg, #020B0D 6.63%, #06313A 41.326%, #0B6470 69.083%, #031014 93.37%)", "#031117DD", "#061A20E3", "#3FE0D0", "#F0FFFD", "#8FB9B6", "#3FE0D03B", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  BN: ["linear-gradient(-146.091deg, #12040A 6.63%, #3A0D1E 41.326%, #6D223B 69.083%, #16060C 93.37%)", "#17060DDD", "#260A16DF", "#D890A8", "#FFF4F7", "#C49AA8", "#D890A83B", "Newsreader", "Geist", "Newsreader"],
  BO: ["linear-gradient(-146.091deg, #ECF7FA 6.63%, #BADDE7 41.326%, #FFF3E9 69.083%, #91C4D2 93.37%)", "#EAF3F4DB", "#FFFFFFDE", "#E36A5C", "#18333C", "#617E86", "#E36A5C35", "Funnel Sans", "Geist", "Funnel Sans"],
  BP: ["linear-gradient(-146.091deg, #030303 6.63%, #171009 41.326%, #3B2B13 69.083%, #050402 93.37%)", "#0C0905DF", "#151008E5", "#D7A84B", "#FFF9E8", "#BBAA82", "#D7A84B42", "Playfair Display", "Newsreader", "Playfair Display"],
  BQ: ["linear-gradient(-146.091deg, #EAF8F4 6.63%, #BFE3D9 41.326%, #FFFDF9 69.083%, #86B9AD 93.37%)", "#ECF7F2DC", "#FFFFFFDE", "#188A78", "#193A34", "#67847D", "#188A7835", "Funnel Sans", "Geist", "Funnel Sans"],
  BR: ["linear-gradient(-146.091deg, #0C0806 6.63%, #32170E 41.326%, #66321B 69.083%, #130B07 93.37%)", "#120B06DF", "#201108E5", "#D86432", "#FFF3EB", "#B79683", "#D8643242", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  BS: ["linear-gradient(-146.091deg, #08040F 6.63%, #2A0B3C 41.326%, #5A1C67 69.083%, #100617 93.37%)", "#100619DD", "#190A26E2", "#D86CFF", "#FCF4FF", "#B8A0C5", "#D86CFF3D", "Space Grotesk", "Geist", "Space Grotesk"],
  BT: ["linear-gradient(-146.091deg, #020915 6.63%, #06304A 41.326%, #145B72 69.083%, #06101F 93.37%)", "#04121CDD", "#061C2AE2", "#56E0FF", "#F1FBFF", "#92AFC0", "#56E0FF3D", "Space Grotesk", "Geist", "Space Grotesk"],
  BU: ["linear-gradient(-146.091deg, #F4F0E6 6.63%, #FFFDF7 41.326%, #E8D9B8 69.083%, #C9C2B4 93.37%)", "#F0ECE2EC", "#FFFEF5F2", "#E23D2D", "#171717", "#66615A", "#1A1A1A", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  BV: ["linear-gradient(-146.091deg, #080B0D 6.63%, #1A2328 41.326%, #243E48 69.083%, #0A0D0F 93.37%)", "#0C1215DD", "#111A1EE3", "#5FE3D1", "#F1FCFA", "#96AAA8", "#5FE3D13B", "IBM Plex Mono", "Geist", "IBM Plex Mono"],
  BW: ["linear-gradient(-146.091deg, #F5E7D8 6.63%, #D7B49B 41.326%, #F9F2E9 69.083%, #9E846D 93.37%)", "#EFE0D2DC", "#FFF9F0E3", "#A65336", "#3E2A22", "#7B665C", "#A6533635", "Newsreader", "Geist", "Newsreader"],
  BX: ["linear-gradient(-146.091deg, #EFF2F6 6.63%, #C7D3E3 41.326%, #F8FAFC 69.083%, #9AAAC0 93.37%)", "#E8EDF5D8", "#FFFFFFDA", "#4A6FA8", "#253448", "#6D7C91", "#4A6FA835", "Space Grotesk", "Geist", "Space Grotesk"],
  BY: ["linear-gradient(-146.091deg, #050606 6.63%, #171A1A 41.326%, #2A3331 69.083%, #080909 93.37%)", "#0A0D0DDF", "#111514E5", "#C8F436", "#F7FAF4", "#A1AAA4", "#C8F4363D", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  BZ: ["linear-gradient(-146.091deg, #FFF0E8 6.63%, #F5C3AE 41.326%, #FFF9F3 69.083%, #D9947F 93.37%)", "#F4E5DDE0", "#FFF9F2E8", "#D9584B", "#452923", "#86675E", "#D9584B35", "Newsreader", "Geist", "Newsreader"],
  CA: ["linear-gradient(-146.091deg, #0E030A 6.63%, #350B22 41.326%, #5F1837 69.083%, #15050D 93.37%)", "#14060FDF", "#210A17E5", "#F06C9B", "#FFF4F8", "#C49AAA", "#F06C9B3D", "Playfair Display", "Geist", "Playfair Display"],
  CB: ["linear-gradient(-146.091deg, #EFF8FD 6.63%, #C4E4F1 41.326%, #FFFDFB 69.083%, #8FB8CC 93.37%)", "#EAF4F8DD", "#FFFFFFE3", "#376EA8", "#1C3853", "#668096", "#376EA835", "Funnel Sans", "Geist", "Funnel Sans"],
  CC: ["linear-gradient(-146.091deg, #F1EBD8 6.63%, #C8C79D 41.326%, #FAF7EE 69.083%, #9A9A6B 93.37%)", "#ECE9D6DE", "#FFFDF3E5", "#68723A", "#30351F", "#71745A", "#68723A35", "Newsreader", "Geist", "Newsreader"],
  CD: ["linear-gradient(-146.091deg, #080307 6.63%, #2D0810 41.326%, #650E20 69.083%, #10040A 93.37%)", "#10050ADF", "#1A0710E5", "#FF4D5A", "#FFF3F5", "#C3929A", "#FF4D5A3D", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  CE: ["linear-gradient(-146.091deg, #F4F1FF 6.63%, #D5D9F4 41.326%, #F8FDFF 69.083%, #A6B7D6 93.37%)", "#ECEAF6D9", "#FFFFFFDC", "#7259C7", "#302A4D", "#746E8D", "#7259C735", "Space Grotesk", "Geist", "Space Grotesk"],
  CF: ["linear-gradient(-146.091deg, #050403 6.63%, #1E140A 41.326%, #49301A 69.083%, #080502 93.37%)", "#0C0905DF", "#161008E5", "#F1B24A", "#FFF7E8", "#BBA587", "#F1B24A42", "Playfair Display", "Newsreader", "Playfair Display"],
  CG: ["linear-gradient(-146.091deg, #ECFAF8 6.63%, #B7E3DC 41.326%, #FFFDF8 69.083%, #7EB8B1 93.37%)", "#EAF7F4DD", "#FFFFFFE3", "#178C9C", "#173B40", "#67858A", "#178C9C35", "Funnel Sans", "Geist", "Funnel Sans"],
  CH: ["linear-gradient(-146.091deg, #E8E2D8 6.63%, #C9C1B5 41.326%, #F5F1E9 69.083%, #A89D90 93.37%)", "#E7E1D8E8", "#F9F6F0ED", "#D96B32", "#20201E", "#6A6762", "#1D1D1D", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  CI: ["linear-gradient(-146.091deg, #020507 6.63%, #001A24 41.326%, #063C49 69.083%, #03080B 93.37%)", "#020C11DD", "#04151CE3", "#00E5FF", "#F0FCFF", "#87ABB3", "#00E5FF3D", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  CJ: ["linear-gradient(-146.091deg, #10040A 6.63%, #3A1022 41.326%, #65273E 69.083%, #17060F 93.37%)", "#17070FDD", "#260B19E3", "#D99BB1", "#FFF4F7", "#C3A0AC", "#D99BB13D", "Playfair Display", "Geist", "Playfair Display"],
  CK: ["linear-gradient(-146.091deg, #FFF5C9 6.63%, #F6D66D 41.326%, #F9F5E7 69.083%, #D6B84D 93.37%)", "#F4E8BEDF", "#FFFDF0EC", "#2855B8", "#25231C", "#746D54", "#1F2B55", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  CL: ["linear-gradient(-146.091deg, #04110D 6.63%, #0C3528 41.326%, #2B4C38 69.083%, #08150F 93.37%)", "#06140FDD", "#0A2119E3", "#65C5A3", "#F0FFF9", "#91B5A7", "#65C5A33D", "Playfair Display", "Geist", "Playfair Display"],
  CM: ["linear-gradient(-146.091deg, #F1F2F4 6.63%, #D6D2E4 41.326%, #FAFAFC 69.083%, #A9AFBF 93.37%)", "#ECEAF1D9", "#FFFFFFDC", "#7764A8", "#313144", "#747489", "#7764A835", "Space Grotesk", "Geist", "Space Grotesk"],
  CN: ["linear-gradient(-146.091deg, #100503 6.63%, #43110C 41.326%, #7D2B19 69.083%, #170704 93.37%)", "#150604DF", "#240B07E5", "#FF664D", "#FFF3EF", "#C39A8E", "#FF664D3D", "Funnel Sans", "Geist", "Funnel Sans"],
  CO: ["linear-gradient(-146.091deg, #020508 6.63%, #041B1A 41.326%, #22113C 69.083%, #05070C 93.37%)", "#040D0DDD", "#071918E3", "#58F0D0", "#F0FFFB", "#8FB3AA", "#58F0D03D", "Space Grotesk", "Geist", "Space Grotesk"],
  CP: ["linear-gradient(-146.091deg, #F8F4E9 6.63%, #E8E0D1 41.326%, #FFFDF8 69.083%, #BDB3A2 93.37%)", "#F1EBDFEB", "#FFFDF2F0", "#191919", "#171717", "#64605A", "#191919", "Archivo Narrow", "IBM Plex Mono", "Archivo Narrow"],
  CQ: ["linear-gradient(-146.091deg, #050A05 6.63%, #172513 41.326%, #314326 69.083%, #09100A 93.37%)", "#0A1008DD", "#101A0DE3", "#B5F55A", "#F7FFF1", "#A1B495", "#B5F55A3D", "Funnel Sans", "Geist", "Funnel Sans"],
  CR: ["linear-gradient(-146.091deg, #03030B 6.63%, #100A31 41.326%, #3A1255 69.083%, #080414 93.37%)", "#090615DD", "#100A22E3", "#FF5EC4", "#FFF2FC", "#B59BB9", "#FF5EC43D", "Space Grotesk", "Geist", "Space Grotesk"],
  CS: [null, "#F2ECDED9", "#FFFDF7E3", "#9A6A24", "#40331F", "#807158", "#9A6A2435", "Playfair Display", "Geist", "Geist"],
  CT: [null, "#0B1216DD", "#111B20E3", "#FF8A3D", "#F5FAFC", "#9CABB0", "#FF8A3D3D", "IBM Plex Mono", "IBM Plex Mono", "IBM Plex Mono"],
  CU: [null, "#EDF2F3E5", "#FFFFFFEB", "#E84545", "#1B2529", "#66757A", "#1A1A1A", "Archivo Narrow", "IBM Plex Mono", "IBM Plex Mono"],
  CV: [null, "#050F29DD", "#08183DE3", "#7CA6FF", "#F2F6FF", "#9DAED0", "#7CA6FF3D", "Funnel Sans", "Geist", "Geist"],
  CW: [null, "#120C09DD", "#1D130EE3", "#72D6B1", "#FFF6EE", "#B5A091", "#72D6B13D", "Newsreader", "Geist", "Geist"],
  CX: [null, "#ECEDE5D8", "#FFFFFFDC", "#A7D93B", "#2C3025", "#71776A", "#657A3135", "Space Grotesk", "Geist", "Geist"],
  CY: [null, "#06101ADD", "#0A1621E3", "#D8B15A", "#FFF8E8", "#A9A88F", "#D8B15A3D", "Playfair Display", "IBM Plex Mono", "IBM Plex Mono"],
  CZ: [null, "#040B0EDD", "#071419E3", "#63F0E0", "#F1FFFC", "#96B2AC", "#63F0E03D", "Space Grotesk", "Geist", "Geist"],
} as const satisfies Record<string, ConceptSourceStyleTuple>

export function getConceptSourceStyle(
  descriptor: ConceptPresetDescriptor,
): ConceptSourceStyle {
  const tuple =
    CONCEPT_SOURCE_STYLE_TUPLES[
      descriptor.code as keyof typeof CONCEPT_SOURCE_STYLE_TUPLES
    ]
  if (tuple === undefined) {
    throw new Error(`Missing source semantics for concept ${descriptor.code}`)
  }

  const [
    background,
    surface,
    card,
    accent,
    foreground,
    mutedForeground,
    border,
    headingFont,
    bodyFont,
    dataFont,
  ] = tuple
  return {
    background,
    surface,
    card,
    accent,
    foreground,
    mutedForeground,
    border,
    headingFont,
    bodyFont,
    dataFont,
  }
}
