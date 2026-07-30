/**
 * One-click WEB Reiwa themes derived from the canonical 104-concept catalog.
 *
 * The source book and audited Pencil boards expose palettes, semantic
 * surfaces, typography and geometry. This adapter persists their fully
 * resolved Reiwa representation, so the runtime never depends on the admin
 * catalog and continues to render it while Rezeis is unavailable.
 */

import {
  CONCEPT_PRESETS,
  getConceptSourceBackgroundColor,
  getConceptSourceMode,
  getConceptSourceStyle,
  type ConceptPresetDescriptor,
  type HexColor,
} from '../../lib/theme/concept-presets'

import type {
  BrandingAppBackgroundDraft,
  BrandingCornerRadiiDraft,
  BrandingFormDraft,
  BrandingSurfaceThemeDraft,
} from './branding-form-schema'

export const THEME_PRESET_VERSION = 2

const FONT_STACK_BY_SOURCE: Readonly<Record<string, string>> = {
  Geist: '"Geist Variable", system-ui, sans-serif',
  'Funnel Sans': '"Funnel Sans Variable", system-ui, sans-serif',
  Archivo: '"Archivo Variable", system-ui, sans-serif',
  'Archivo Narrow': '"Archivo Narrow Variable", system-ui, sans-serif',
  Nunito: '"Nunito Variable", system-ui, sans-serif',
  Newsreader: '"Newsreader Variable", Georgia, serif',
  'Playfair Display': '"Playfair Display Variable", Georgia, serif',
  'Source Sans 3': '"Source Sans 3 Variable", system-ui, sans-serif',
  'Space Grotesk': '"Space Grotesk Variable", system-ui, sans-serif',
  'IBM Plex Mono': '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
}

export interface ThemePreset {
  readonly id: string
  readonly version: number
  readonly code: string
  readonly name: string
  readonly palette: readonly HexColor[]
  readonly sourcePage: number
  readonly visualFamily: string
  readonly primary: HexColor
  readonly primaryFg: HexColor
  readonly bgPrimary: HexColor
  readonly bgSecondary: HexColor
  readonly cardGradient: string
  readonly cardPattern: string | null
  readonly cardEffect: string
  readonly cardEffectProps: Readonly<Record<string, unknown>>
  readonly cardEffectOpacity: number
  readonly bgEffect: 'NONE' | 'MESH' | 'PARTICLES' | 'NOISE' | 'AURORA'
  readonly appBackground: BrandingAppBackgroundDraft
  readonly borderRadius: string
  readonly cornerRadii: BrandingCornerRadiiDraft
  readonly fontFamily: string
  readonly surfaceTheme: BrandingSurfaceThemeDraft
}

export const THEME_PRESETS: readonly ThemePreset[] = CONCEPT_PRESETS.map(
  createConceptReiwaPreset,
)

export const THEME_PRESET_BY_ID: Readonly<Record<string, ThemePreset>> =
  Object.fromEntries(THEME_PRESETS.map((preset) => [preset.id, preset]))

export type ThemePresetVisualPatch = Pick<
  BrandingFormDraft,
  | 'themePresetId'
  | 'themePresetVersion'
  | 'primary'
  | 'primaryFg'
  | 'bgPrimary'
  | 'bgSecondary'
  | 'cardGradient'
  | 'cardPattern'
  | 'cardEffect'
  | 'cardEffectProps'
  | 'cardEffectOpacity'
  | 'bgEffect'
  | 'appBackground'
  | 'borderRadius'
  | 'cornerRadii'
  | 'fontFamily'
  | 'surfaceTheme'
>

export function createThemePresetVisualPatch(
  preset: ThemePreset,
): ThemePresetVisualPatch {
  return {
    themePresetId: preset.id,
    themePresetVersion: preset.version,
    primary: preset.primary,
    primaryFg: preset.primaryFg,
    bgPrimary: preset.bgPrimary,
    bgSecondary: preset.bgSecondary,
    cardGradient: preset.cardGradient,
    cardPattern: preset.cardPattern,
    cardEffect: preset.cardEffect,
    cardEffectProps: { ...preset.cardEffectProps },
    cardEffectOpacity: preset.cardEffectOpacity,
    bgEffect: preset.bgEffect,
    appBackground: preset.appBackground,
    borderRadius: preset.borderRadius,
    cornerRadii: preset.cornerRadii,
    fontFamily: preset.fontFamily,
    surfaceTheme: preset.surfaceTheme,
  }
}

export function createConceptReiwaPreset(
  descriptor: ConceptPresetDescriptor,
): ThemePreset {
  const source = getConceptSourceStyle(descriptor)
  const isLight = getConceptSourceMode(descriptor) === 'light'
  const bgPrimary = getConceptSourceBackgroundColor(descriptor)
  const foreground = ensureTextContrast(
    opaqueHex(source.foreground),
    bgPrimary,
  )
  const primary = opaqueHex(source.accent)
  const secondaryAccent = pickPrimary(
    descriptor.palette.filter((color) => color !== primary) as HexColor[],
    bgPrimary,
  )
  const surface = opaqueHex(source.surface)
  const surfaceHigh = opaqueHex(source.card)
  const mutedForeground = ensureTextContrast(
    opaqueHex(source.mutedForeground),
    surface,
  )
  const border = opaqueHex(source.border)
  const appGradient = buildBackgroundGradient(descriptor, bgPrimary)
  const effect = deriveCardEffect(descriptor)
  const cardPattern = deriveCardPattern(descriptor, primary)
  const hasBlur = descriptor.classification.backgroundBlur
  const cornerRadii = exactCornerRadii(descriptor)

  return {
    id: descriptor.id,
    version: THEME_PRESET_VERSION,
    code: descriptor.code,
    name: descriptor.name,
    palette: descriptor.palette,
    sourcePage: descriptor.sourcePage,
    visualFamily: descriptor.classification.visualFamily,
    primary,
    primaryFg: contrastText(primary),
    bgPrimary,
    bgSecondary: surface,
    cardGradient: buildCardGradient(descriptor, bgPrimary),
    cardPattern,
    cardEffect: effect,
    cardEffectProps: buildEffectProps(
      effect,
      primary,
      secondaryAccent,
      bgPrimary,
    ),
    cardEffectOpacity: descriptor.classification.effectClass === 'flat' ? 0.45 : 0.72,
    bgEffect: deriveLegacyBgEffect(descriptor),
    appBackground: buildAppBackground(
      descriptor,
      appGradient,
      primary,
      bgPrimary,
    ),
    borderRadius: radiusClassForConcept(descriptor),
    cornerRadii,
    fontFamily: fontStack(source.bodyFont),
    surfaceTheme: {
      foreground,
      mutedForeground,
      surface,
      surfaceHigh,
      borderSoft: border,
      borderStrong: ensureUiContrast(border, surface),
      surfaceOpacity: sourceAlpha(source.surface, hasBlur ? (isLight ? 0.72 : 0.64) : 0.9),
      surfaceHighOpacity: sourceAlpha(source.card, hasBlur ? (isLight ? 0.84 : 0.78) : 0.96),
      borderSoftOpacity: sourceAlpha(source.border, isLight ? 0.18 : 0.14),
      borderStrongOpacity: Math.min(
        1,
        Math.max(0.32, sourceAlpha(source.border, isLight ? 0.28 : 0.24) * 1.6),
      ),
      glassBlurPx: hasBlur
        ? Math.min(32, Math.max(12, descriptor.classification.canonicalRadius))
        : 0,
    },
  }
}

function pickPrimary(
  palette: readonly HexColor[],
  canvas: HexColor,
): HexColor {
  const candidates = palette.filter((color) => color !== canvas)
  return [...(candidates.length > 0 ? candidates : palette)].sort(
    (left, right) => primaryScore(right, canvas) - primaryScore(left, canvas),
  )[0]
}

function primaryScore(color: HexColor, canvas: HexColor): number {
  const lightness = luminance(color)
  const usable = lightness > 0.015 && lightness < 0.96 ? 0.4 : 0
  return chroma(color) * 1.7 + Math.min(contrastRatio(color, canvas), 7) / 10 + usable
}

function contrastText(background: HexColor): HexColor {
  const black: HexColor = '#000000'
  const white: HexColor = '#FFFFFF'
  return contrastRatio(black, background) >= contrastRatio(white, background)
    ? black
    : white
}

function opaqueHex(color: HexColor): HexColor {
  if (color.length === 4 || color.length === 5) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}` as HexColor
  }
  return color.slice(0, 7) as HexColor
}

function sourceAlpha(color: HexColor, fallback: number): number {
  if (color.length === 5) {
    return Number.parseInt(`${color[4]}${color[4]}`, 16) / 255
  }
  if (color.length === 9) {
    return Number.parseInt(color.slice(7, 9), 16) / 255
  }
  return fallback
}

function ensureTextContrast(
  preferred: HexColor,
  background: HexColor,
): HexColor {
  if (contrastRatio(preferred, background) >= 4.5) return preferred
  const target = contrastText(background)
  for (let preferredWeight = 0.99; preferredWeight >= 0; preferredWeight -= 0.01) {
    const candidate = mixHex(preferred, target, preferredWeight)
    if (contrastRatio(candidate, background) >= 4.6) return candidate
  }
  return target
}

function ensureUiContrast(
  preferred: HexColor,
  background: HexColor,
): HexColor {
  if (contrastRatio(preferred, background) >= 3) return preferred
  const target = contrastText(background)
  for (let preferredWeight = 0.99; preferredWeight >= 0; preferredWeight -= 0.01) {
    const candidate = mixHex(preferred, target, preferredWeight)
    if (contrastRatio(candidate, background) >= 3.1) return candidate
  }
  return target
}

function buildCardGradient(
  descriptor: ConceptPresetDescriptor,
  canvas: HexColor,
): string {
  const source = getConceptSourceStyle(descriptor)
  const card = opaqueHex(source.card)
  const surface = opaqueHex(source.surface)
  const accent = opaqueHex(source.accent)
  return `linear-gradient(135deg, ${card} 0%, ${mixHex(card, accent, 0.78)} 58%, ${mixHex(surface, canvas, 0.72)} 100%)`
}

function buildBackgroundGradient(
  descriptor: ConceptPresetDescriptor,
  canvas: HexColor,
): string {
  const source = getConceptSourceStyle(descriptor)
  if (source.background?.includes('gradient(')) {
    return source.background
  }
  if (source.background?.startsWith('#')) {
    const solid = opaqueHex(source.background as HexColor)
    return `linear-gradient(135deg, ${solid} 0%, ${solid} 100%)`
  }

  const [a, b, c, d] = descriptor.palette
  return [
    `radial-gradient(circle at 12% 8%, ${withAlpha(a, '8F')} 0%, transparent 40%)`,
    `radial-gradient(circle at 88% 16%, ${withAlpha(c, '70')} 0%, transparent 44%)`,
    `radial-gradient(circle at 50% 100%, ${withAlpha(d, '66')} 0%, transparent 48%)`,
    `linear-gradient(145deg, ${canvas} 0%, ${b} 100%)`,
  ].join(', ')
}

function deriveCardPattern(
  descriptor: ConceptPresetDescriptor,
  primary: HexColor,
): string | null {
  const tags = new Set(descriptor.classification.visualTags)
  if (tags.has('technical')) {
    const line = withAlpha(primary, '24')
    return `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`
  }
  if (tags.has('editorial')) {
    return `repeating-linear-gradient(0deg, ${withAlpha(primary, '14')} 0 1px, transparent 1px 6px)`
  }
  if (descriptor.classification.decorDensity === 'dense') {
    return `radial-gradient(circle, ${withAlpha(primary, '24')} 1px, transparent 1.5px)`
  }
  return null
}

function deriveCardEffect(descriptor: ConceptPresetDescriptor): string {
  const name = descriptor.name.toLocaleLowerCase()
  const tags = new Set(descriptor.classification.visualTags)

  if (/paper|linen|parchment|editorial|collage|swiss/.test(name)) return 'paperGrain'
  if (/chrome|metal|silver|pearl|porcelain|ceramic|prism|hologram/.test(name)) {
    return 'liquidChrome'
  }
  if (/ocean|lagoon|wave|tide/.test(name)) return 'lineWaves'
  if (/aurora|borealis/.test(name)) return 'softAurora'
  if (/space|nebula|orbit|lunar|neptune|venus|martian|saturn/.test(name)) {
    return 'galaxy'
  }
  if (/grid|circuit|blueprint|matrix|data|terminal|signal|map|cartograph/.test(name)) {
    return 'rippleGrid'
  }
  if (/smoke|mist|plasma|bloom|veil/.test(name)) return 'plasma'
  if (tags.has('technical')) return 'dither'
  if (tags.has('editorial')) return 'paperGrain'
  if (descriptor.classification.backgroundBlur) return 'softAurora'
  return 'grainient'
}

function buildEffectProps(
  effect: string,
  primary: HexColor,
  accent: HexColor,
  background: HexColor,
): Readonly<Record<string, unknown>> {
  const rgb = normalizedRgb(primary)
  switch (effect) {
    case 'softAurora':
      return { color1: primary, color2: accent, speed: 0.45, brightness: 0.82 }
    case 'rippleGrid':
      return { gridColor: primary, gridSize: 12, glowIntensity: 0.16 }
    case 'plasma':
      return { color: primary, speed: 0.55, scale: 1.25 }
    case 'liquidChrome':
      return { baseColor: rgb, speed: 0.16, amplitude: 0.42 }
    case 'lineWaves':
      return {
        color1: primary,
        color2: accent,
        color3: contrastText(background),
        speed: 0.24,
        brightness: 0.28,
      }
    case 'galaxy':
      return { hueShift: rgbToHue(rgb), density: 0.75, glowIntensity: 0.22 }
    case 'dither':
      return { waveColor: rgb, waveSpeed: 0.035, pixelSize: 2, colorNum: 4 }
    case 'paperGrain':
      return {
        colorBack: background,
        colors: [primary, accent, mixHex(primary, background, 0.55), background],
        speed: 0.35,
        noise: 0.2,
      }
    case 'grainient':
      return {
        color1: primary,
        color2: accent,
        color3: background,
        timeSpeed: 0.18,
        grainAmount: 0.08,
      }
    default:
      return { colorStops: [primary, accent, primary], speed: 0.6 }
  }
}

function buildAppBackground(
  descriptor: ConceptPresetDescriptor,
  gradient: string,
  primary: HexColor,
  background: HexColor,
): BrandingAppBackgroundDraft {
  const tags = new Set(descriptor.classification.visualTags)
  const pattern = tags.has('technical') ? 'grid' : 'noise'

  return {
    kind: descriptor.classification.backgroundType === 'solid' ? 'none' : 'gradient',
    effect: 'NONE',
    props: {},
    opacity: 1,
    gradient,
    texture: {
      pattern,
      color: primary,
      background,
      scale: tags.has('technical') ? 28 : 64,
      opacity: tags.has('technical') ? 0.14 : 0.1,
    },
  }
}

function deriveLegacyBgEffect(
  descriptor: ConceptPresetDescriptor,
): ThemePreset['bgEffect'] {
  if (descriptor.classification.backgroundType === 'mesh-gradient') return 'MESH'
  if (descriptor.classification.visualTags.includes('technical')) return 'PARTICLES'
  if (descriptor.classification.visualTags.includes('editorial')) return 'NOISE'
  return descriptor.classification.backgroundBlur ? 'AURORA' : 'NONE'
}

function radiusClass(radius: number): string {
  if (radius <= 3) return 'rounded-none'
  if (radius <= 10) return 'rounded-lg'
  if (radius <= 16) return 'rounded-xl'
  if (radius <= 22) return 'rounded-2xl'
  if (radius <= 30) return 'rounded-3xl'
  return 'rounded-full'
}

function radiusClassForConcept(descriptor: ConceptPresetDescriptor): string {
  if (descriptor.classification.radiusClass === 'square') return 'rounded-none'
  if (descriptor.classification.radiusClass === 'compact') return 'rounded-lg'
  return radiusClass(descriptor.classification.canonicalRadius)
}

function exactCornerRadii(
  descriptor: ConceptPresetDescriptor,
): BrandingCornerRadiiDraft {
  const sourceCardRadius =
    descriptor.classification.radiusClass === 'square'
      ? descriptor.classification.canonicalRadius
      : descriptor.classification.surfaceRadius
  const surface = Math.min(48, Math.max(0, sourceCardRadius))
  const item = Math.min(
    32,
    Math.max(
      0,
      descriptor.classification.radiusClass === 'square'
        ? surface
        : Math.min(surface, descriptor.classification.canonicalRadius),
    ),
  )
  const pill =
    descriptor.classification.radiusClass === 'square'
      ? item
      : descriptor.classification.radiusClass === 'compact'
        ? Math.min(16, Math.max(item, 4))
        : 9999
  return { cardPx: surface, itemPx: item, pillPx: pill }
}

export interface FontOption {
  readonly id: string
  readonly label: string
  readonly value: string
}

export const FONT_OPTIONS: readonly FontOption[] = [
  { id: 'geist', label: 'Geist', value: FONT_STACK_BY_SOURCE.Geist },
  {
    id: 'funnelSans',
    label: 'Funnel Sans',
    value: FONT_STACK_BY_SOURCE['Funnel Sans'],
  },
  { id: 'archivo', label: 'Archivo', value: FONT_STACK_BY_SOURCE.Archivo },
  {
    id: 'archivoNarrow',
    label: 'Archivo Narrow',
    value: FONT_STACK_BY_SOURCE['Archivo Narrow'],
  },
  { id: 'nunito', label: 'Nunito', value: FONT_STACK_BY_SOURCE.Nunito },
  {
    id: 'newsreader',
    label: 'Newsreader',
    value: FONT_STACK_BY_SOURCE.Newsreader,
  },
  {
    id: 'playfairDisplay',
    label: 'Playfair Display',
    value: FONT_STACK_BY_SOURCE['Playfair Display'],
  },
  {
    id: 'sourceSans3',
    label: 'Source Sans 3',
    value: FONT_STACK_BY_SOURCE['Source Sans 3'],
  },
  {
    id: 'spaceGrotesk',
    label: 'Space Grotesk',
    value: FONT_STACK_BY_SOURCE['Space Grotesk'],
  },
  {
    id: 'ibmPlexMono',
    label: 'IBM Plex Mono',
    value: FONT_STACK_BY_SOURCE['IBM Plex Mono'],
  },
  { id: 'system', label: 'System UI', value: 'Inter, system-ui, sans-serif' },
] as const

function fontStack(font: string): string {
  return FONT_STACK_BY_SOURCE[font] ?? FONT_STACK_BY_SOURCE.Geist
}

export interface CardGradientPreset {
  readonly id: string
  readonly value: string
}

export const CARD_GRADIENT_PRESETS: readonly CardGradientPreset[] = [
  { id: 'emerald', value: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)' },
  { id: 'indigo', value: 'linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)' },
  { id: 'sunset', value: 'linear-gradient(135deg, #7c2d12 0%, #f97316 100%)' },
  { id: 'rose', value: 'linear-gradient(135deg, #881337 0%, #f43f5e 100%)' },
  { id: 'cyan', value: 'linear-gradient(135deg, #164e63 0%, #06b6d4 100%)' },
  { id: 'violet', value: 'linear-gradient(135deg, #4c1d95 0%, #a855f7 100%)' },
  { id: 'amber', value: 'linear-gradient(135deg, #78350f 0%, #f59e0b 100%)' },
  { id: 'slate', value: 'linear-gradient(135deg, #1e293b 0%, #64748b 100%)' },
  {
    id: 'midnight',
    value: 'linear-gradient(135deg, #0f172a 0%, #334155 60%, #0ea5e9 100%)',
  },
  {
    id: 'aurora',
    value: 'linear-gradient(135deg, #042f2e 0%, #0d9488 45%, #6366f1 100%)',
  },
  {
    id: 'fire',
    value: 'linear-gradient(135deg, #7f1d1d 0%, #dc2626 50%, #f59e0b 100%)',
  },
  {
    id: 'grape',
    value: 'linear-gradient(135deg, #2e1065 0%, #7c3aed 55%, #ec4899 100%)',
  },
  {
    id: 'ocean',
    value: 'linear-gradient(135deg, #0c4a6e 0%, #0284c7 50%, #06b6d4 100%)',
  },
  {
    id: 'forest',
    value: 'linear-gradient(135deg, #14532d 0%, #16a34a 60%, #84cc16 100%)',
  },
  {
    id: 'gold',
    value: 'linear-gradient(135deg, #422006 0%, #a16207 50%, #facc15 100%)',
  },
  { id: 'mono', value: 'linear-gradient(135deg, #262626 0%, #525252 100%)' },
  {
    id: 'glow',
    value: 'radial-gradient(circle at 30% 20%, #6366f1 0%, #1e1b4b 70%)',
  },
  {
    id: 'spotlight',
    value: 'radial-gradient(circle at 70% 30%, #f43f5e 0%, #4c0519 75%)',
  },
  {
    id: 'conic',
    value:
      'conic-gradient(from 210deg at 70% 30%, #6366f1, #ec4899, #f59e0b, #6366f1)',
  },
  {
    id: 'nebula',
    value:
      'radial-gradient(circle at 50% 0%, #7c3aed 0%, #1e1b4b 55%, #020617 100%)',
  },
] as const

export function gradientFromPrimary(primary: string): string {
  const dark = shade(primary, -0.55)
  return `linear-gradient(135deg, ${dark} 0%, ${primary} 100%)`
}

function parseHex(hex: HexColor): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function normalizedRgb(hex: HexColor): readonly [number, number, number] {
  const { r, g, b } = parseHex(hex)
  return [r / 255, g / 255, b / 255]
}

function rgbToHue(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  const raw =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4
  return Math.round((raw * 60 + 360) % 360)
}

function linearChannel(channel: number): number {
  const value = channel / 255
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex: HexColor): number {
  const { r, g, b } = parseHex(hex)
  return (
    0.2126 * linearChannel(r) +
    0.7152 * linearChannel(g) +
    0.0722 * linearChannel(b)
  )
}

function contrastRatio(left: HexColor, right: HexColor): number {
  const light = Math.max(luminance(left), luminance(right))
  const dark = Math.min(luminance(left), luminance(right))
  return (light + 0.05) / (dark + 0.05)
}

function chroma(hex: HexColor): number {
  const { r, g, b } = parseHex(hex)
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255
}

function mixHex(left: HexColor, right: HexColor, leftWeight: number): HexColor {
  const a = parseHex(left)
  const b = parseHex(right)
  const rightWeight = 1 - leftWeight
  const channel = (x: number, y: number): string =>
    Math.round(x * leftWeight + y * rightWeight)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase()
  return `#${channel(a.r, b.r)}${channel(a.g, b.g)}${channel(a.b, b.b)}`
}

function withAlpha(hex: HexColor, alpha: string): string {
  return `${hex}${alpha}`
}

function shade(hex: string, amount: number): string {
  const normalized = hex.trim().replace(/^#/, '')
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((character) => character + character)
          .join('')
      : normalized
  if (full.length < 6) return hex
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  const mix = (value: number): number =>
    amount >= 0
      ? Math.round(value + (255 - value) * amount)
      : Math.round(value * (1 + amount))
  const toHex = (value: number): string =>
    Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}
