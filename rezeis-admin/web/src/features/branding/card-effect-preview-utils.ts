/** Pure card-preview helpers shared by the live renderer and configurator UI. */

import {
  CARD_EFFECT_COMPONENTS,
  type CardEffectId,
} from './card-effect-registry'

export const PAPER_CARD_EFFECTS = new Set([
  'paperMesh',
  'paperWarp',
  'paperGrain',
  'paperDither',
  'paperSwirl',
  'paperMetaballs',
])

const CANVAS_2D_EFFECTS = new Set(['waves'])

const DEFAULT_EFFECT_COLORS: Readonly<Record<string, readonly string[]>> = {
  aurora: ['#5227FF', '#7CFF67', '#5227FF'],
  threads: ['#ffffff'],
  softAurora: ['#f7f7f7', '#e100ff'],
  rippleGrid: ['#ffffff'],
  radar: ['#9f29ff', '#000000'],
  plasma: ['#ffffff', '#000000'],
  particles: ['#ffffff'],
  liquidChrome: ['#1a1a1a', '#000000', '#ffffff'],
  lineWaves: ['#ffffff'],
  iridescence: ['#ffffff', '#000000'],
  grainient: ['#ff9ffc', '#5227ff', '#b497cf'],
  galaxy: ['#ffffff', '#000000'],
  balatro: ['#de443b', '#006bb4', '#162325'],
  waves: ['#ffffff', '#00000000'],
  silk: ['#7b7481'],
  beams: ['#ffffff', '#000000'],
  dither: ['#808080', '#000000'],
  paperMesh: ['#e0eaff', '#241d9a', '#f75092', '#9f50d3'],
  paperWarp: ['#121212', '#9470ff', '#8838ff'],
  paperGrain: ['#000000', '#7300ff', '#eba8ff', '#00bfff', '#2a00ff'],
  paperDither: ['#000000', '#00b2ff'],
  paperSwirl: ['#000000', '#ffd1d1', '#ff8a8a', '#660000'],
  paperMetaballs: ['#000000', '#6e33cc', '#ff5500', '#ffc105', '#f585ff'],
}

const FULL_OUTPUT_GAMUT_EFFECTS = new Set([
  'softAurora',
  'rippleGrid',
  'radar',
  'particles',
  'liquidChrome',
  'lineWaves',
  'grainient',
  'galaxy',
  'balatro',
])

export function resolveCardEffectPreviewOpacity(opacity: number): number {
  return Math.min(Math.max(Number.isFinite(opacity) ? opacity : 1, 0.05), 1)
}

export function isPreviewCardEffect(effect: string): effect is CardEffectId {
  return effect !== 'NONE' && effect in CARD_EFFECT_COMPONENTS
}

export function requiresPreviewCardEffectWebGL(effect: string): boolean {
  return effect !== 'NONE' && !CANVAS_2D_EFFECTS.has(effect)
}

export function resolveCardEffectPreviewColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const fromArray = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => isSafeHexColor(entry))
      : []
  const asHex = (value: unknown): string | null =>
    isSafeHexColor(value) ? value : null

  const colors = [
    ...fromArray(props['colors']),
    ...fromArray(props['colorStops']),
    ...fromArray(props['particleColors']),
    ...[
      'color1',
      'color2',
      'color3',
      'color',
      'colorBack',
      'colorFront',
      'gridColor',
      'lineColor',
      'backgroundColor',
      'lightColor',
    ]
      .map((key) => asHex(props[key]))
      .filter((value): value is string => value !== null),
    ...['baseColor', 'waveColor', 'color']
      .map((key) => rgbVectorColor(props[key]))
      .filter((value): value is string => value !== null),
  ]

  if (effect === 'rippleGrid' && props['enableRainbow'] === true) {
    colors.push('#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff')
  }
  if (['dither', 'radar', 'plasma', 'beams', 'galaxy'].includes(effect)) {
    colors.push('#000000')
  }
  if (['liquidChrome', 'galaxy'].includes(effect)) colors.push('#ffffff')

  return colors.length > 0
    ? [...new Set(colors)]
    : (DEFAULT_EFFECT_COLORS[effect] ?? DEFAULT_EFFECT_COLORS.aurora)
}

export function resolveCardEffectPreviewOutputColors(
  effect: string,
  props: Readonly<Record<string, unknown>>,
): readonly string[] {
  const colors = [...resolveCardEffectPreviewColors(effect, props)]
  if (FULL_OUTPUT_GAMUT_EFFECTS.has(effect)) {
    colors.push('#000000', '#ffffff')
  }
  return [...new Set(colors)]
}

export function buildCardEffectPreviewArtwork(colors: readonly string[]): string {
  const first = colors[0] ?? '#5227FF'
  const middle = colors[Math.floor((colors.length - 1) / 2)] ?? first
  const last = colors.at(-1) ?? middle
  // Keep fallback art translucent at every selected opacity. The configured
  // gradient is the card foundation; a fallback must enhance it, never replace
  // it with a full-frame palette of its own.
  return `radial-gradient(70% 110% at 4% 100%, ${first} 0%, transparent 72%), radial-gradient(66% 100% at 100% 2%, ${last} 0%, transparent 72%), radial-gradient(54% 66% at 52% 50%, ${middle} 0%, transparent 82%)`
}

function isSafeHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[\da-f]{3,8}$/i.test(value)
}

function rgbVectorColor(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((channel) => typeof channel !== 'number' || !Number.isFinite(channel))
  ) {
    return null
  }
  const scale = value.every((channel) => channel >= 0 && channel <= 1) ? 255 : 1
  return `#${value
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel * scale)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
