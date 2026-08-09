/**
 * Effect id → the React component the configurator previews it with.
 *
 * Everything else about an effect — its name, its tunable controls, what it
 * needs from the device, its fallback palette — lives in `card-effect-catalog.ts`,
 * which this file re-exports so the existing call sites did not have to move.
 * The split exists because the catalog must stay importable without pulling a
 * shader in behind it: the backend's contract test reads it directly to check
 * that its validation list still matches what the panel offers.
 *
 * The map is typed `Record<CardEffectId, …>`, so an effect added to the catalog
 * without a preview component here — or a component here with no catalog entry
 * — is a compile error rather than an empty tile in the grid.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

import type { CardEffectId } from './card-effect-catalog'

type EffectComponent = LazyExoticComponent<ComponentType<Record<string, unknown>>>

/** Lazy components reused from the admin's reactbits set (preview only). */
export const CARD_EFFECT_COMPONENTS: Record<CardEffectId, EffectComponent> = {
  aurora: lazy(() => import('@/components/reactbits/Aurora')),
  threads: lazy(() => import('@/components/reactbits/Threads')),
  softAurora: lazy(() => import('@/components/reactbits/SoftAurora')),
  rippleGrid: lazy(() => import('@/components/reactbits/RippleGrid')),
  radar: lazy(() => import('@/components/reactbits/Radar')),
  plasma: lazy(() => import('@/components/reactbits/Plasma')),
  particles: lazy(() => import('@/components/reactbits/Particles')),
  liquidChrome: lazy(() => import('@/components/reactbits/LiquidChrome')),
  lineWaves: lazy(() => import('@/components/reactbits/LineWaves')),
  iridescence: lazy(() => import('@/components/reactbits/Iridescence')),
  grainient: lazy(() => import('@/components/reactbits/Grainient')),
  galaxy: lazy(() => import('@/components/reactbits/Galaxy')),
  balatro: lazy(() => import('@/components/reactbits/Balatro')),
  waves: lazy(() => import('@/components/reactbits/Waves')),
  silk: lazy(() => import('@/components/reactbits/Silk')),
  beams: lazy(() => import('@/components/reactbits/Beams')),
  dither: lazy(() => import('@/components/reactbits/Dither')),
  paperMesh: lazy(() => import('@/components/reactbits/paper').then((m) => ({ default: m.PaperMesh }))),
  paperWarp: lazy(() => import('@/components/reactbits/paper').then((m) => ({ default: m.PaperWarp }))),
  paperGrain: lazy(() => import('@/components/reactbits/paper').then((m) => ({ default: m.PaperGrain }))),
  paperDither: lazy(() => import('@/components/reactbits/paper').then((m) => ({ default: m.PaperDither }))),
  paperSwirl: lazy(() => import('@/components/reactbits/paper').then((m) => ({ default: m.PaperSwirl }))),
  paperMetaballs: lazy(() => import('@/components/reactbits/paper').then((m) => ({ default: m.PaperMetaballs }))),
  // Originkit — see the catalog.
  snowfall: lazy(() => import('@/components/reactbits/originkit/Snowfall')),
  stardust: lazy(() => import('@/components/reactbits/originkit/Stardust')),
  asciiRain: lazy(() => import('@/components/reactbits/originkit/AsciiRain')),
  asciiFlame: lazy(() => import('@/components/reactbits/originkit/AsciiFlame')),
  characterWaves: lazy(() => import('@/components/reactbits/originkit/CharacterWaves')),
  blinkingSquares: lazy(() => import('@/components/reactbits/originkit/BlinkingSquares')),
  lineRipple: lazy(() => import('@/components/reactbits/originkit/LineRippleBackground')),
  pulseLines: lazy(() => import('@/components/reactbits/originkit/PulseLines')),
  textWave: lazy(() => import('@/components/reactbits/originkit/TextWave')),
  pixelCard: lazy(() => import('@/components/reactbits/originkit/PixelCard')),
  glitterWrap: lazy(() => import('@/components/reactbits/originkit/GlitterWrap')),
  chromaticWaves: lazy(() => import('@/components/reactbits/originkit/ChromaticWaves')),
  dotMatrix: lazy(() => import('@/components/reactbits/originkit/DotMatrix')),
  pixelTetris: lazy(() => import('@/components/reactbits/originkit/PixelTetris')),
  risingLines: lazy(() => import('@/components/reactbits/originkit/RisingLines')),
  starBurst: lazy(() => import('@/components/reactbits/originkit/StarBurst')),
  particleTunnel: lazy(() => import('@/components/reactbits/originkit/ParticleTunnel')),
  floatingIcons: lazy(() => import('@/components/reactbits/originkit/FloatingIcons')),
  snakeGrid: lazy(() => import('@/components/reactbits/originkit/SnakeGrid')),
  gridHole: lazy(() => import('@/components/reactbits/originkit/GridHole')),
  waveArcs: lazy(() => import('@/components/reactbits/originkit/WaveArcs')),
  reactiveGrid: lazy(() => import('@/components/reactbits/originkit/ReactiveGrid')),
  reactiveLines: lazy(() => import('@/components/reactbits/originkit/ReactiveLines')),
  prismGrid: lazy(() => import('@/components/reactbits/originkit/PrismGrid')),
  thunderstrike: lazy(() => import('@/components/reactbits/originkit/Thunderstrike')),
  blackhole: lazy(() => import('@/components/reactbits/originkit/Blackhole')),
  cosmicOrb: lazy(() => import('@/components/reactbits/originkit/CosmicOrb')),
  tornado: lazy(() => import('@/components/reactbits/originkit/Tornado')),
  cube: lazy(() => import('@/components/reactbits/originkit/Cube')),
  wordGlobe: lazy(() => import('@/components/reactbits/originkit/WordGlobe')),
  particleSphere: lazy(() => import('@/components/reactbits/originkit/Particlesphere')),
  // Repaired reactbits — see the catalog. Not vendored from originkit, so these
  // sit directly under `reactbits/` and are frozen by
  // `card-effect-components-manifest.test.ts` rather than by the originkit one.
  colorBends: lazy(() => import('@/components/reactbits/ColorBends')),
  pixelBlast: lazy(() => import('@/components/reactbits/PixelBlast')),
  plasmaWave: lazy(() => import('@/components/reactbits/PlasmaWave')),
  evilEye: lazy(() => import('@/components/reactbits/EvilEye')),
  lightPillar: lazy(() => import('@/components/reactbits/LightPillar')),
  prismaticBurst: lazy(() => import('@/components/reactbits/PrismaticBurst')),
  faultyTerminal: lazy(() => import('@/components/reactbits/FaultyTerminal')),
  letterGlitch: lazy(() => import('@/components/reactbits/LetterGlitch')),
  shapeGrid: lazy(() => import('@/components/reactbits/ShapeGrid')),
  magicRings: lazy(() => import('@/components/reactbits/MagicRings')),
  laserFlow: lazy(() => import('@/components/reactbits/LaserFlow')),
  antigravity: lazy(() => import('@/components/reactbits/Antigravity')),
}

export {
  CARD_EFFECT_CATALOG,
  CARD_EFFECT_REGISTRY,
  cardEffectPalette,
  cardEffectRenderer,
  getCardEffectDef,
  getCardEffectDefaults,
  hasFullOutputGamut,
  isKnownCardEffect,
  type CardEffectDef,
  type CardEffectEntry,
  type CardEffectId,
  type CardEffectRenderer,
} from './card-effect-catalog'
