/**
 * Backgrounds — shared lazy-loaded React Bits background components.
 * Single source of truth for both `GlassBackground` (production) and
 * `glass-settings-card` (preview). Adding a new BackgroundId in the
 * store requires adding an entry here too — the typed Record forces
 * the compiler to enforce this.
 *
 * The raw importers are exported alongside the `lazy()` components on
 * purpose. `lazy(loader)` can only be triggered by RENDERING it, which for
 * these components means creating a WebGL context and starting a rAF loop —
 * so it is useless for warming the chunk on the login screen, where the whole
 * point is to have none of that running. `BG_LOADERS[id]()` fetches and
 * evaluates the module and stops there: every module under `reactbits/`
 * contains only definitions at the top level (shader strings, helper
 * functions, the component function itself), so nothing touches the GPU
 * until React renders it. `GlassBackground` relies on that, and
 * `GlassBackground.test.tsx` asserts it rather than trusting it.
 */
import { lazy, type LazyExoticComponent, type ComponentType } from 'react'
import type { BackgroundId } from '@/lib/theme/glass-store'

type BgProps = Record<string, unknown>
type BgComponent = LazyExoticComponent<ComponentType<BgProps>>
type BgLoader = () => Promise<{ default: ComponentType<BgProps> }>

/** Module importers, keyed by BackgroundId. Safe to call without mounting. */
export const BG_LOADERS: Record<Exclude<BackgroundId, 'none'>, BgLoader> = {
  silk: () => import('@/components/reactbits/Silk'),
  aurora: () => import('@/components/reactbits/Aurora'),
  threads: () => import('@/components/reactbits/Threads'),
  waves: () => import('@/components/reactbits/Waves'),
  iridescence: () => import('@/components/reactbits/Iridescence'),
  galaxy: () => import('@/components/reactbits/Galaxy'),
  particles: () => import('@/components/reactbits/Particles'),
  dotGrid: () => import('@/components/reactbits/DotGrid'),
  liquidChrome: () => import('@/components/reactbits/LiquidChrome'),
  balatro: () => import('@/components/reactbits/Balatro'),
  beams: () => import('@/components/reactbits/Beams'),
  plasma: () => import('@/components/reactbits/Plasma'),
  grainient: () => import('@/components/reactbits/Grainient'),
  softAurora: () => import('@/components/reactbits/SoftAurora'),
  dither: () => import('@/components/reactbits/Dither'),
  lineWaves: () => import('@/components/reactbits/LineWaves'),
  rippleGrid: () => import('@/components/reactbits/RippleGrid'),
  lightning: () => import('@/components/reactbits/Lightning'),
  radar: () => import('@/components/reactbits/Radar'),
  colorBends: () => import('@/components/reactbits/ColorBends'),
  pixelBlast: () => import('@/components/reactbits/PixelBlast'),
  plasmaWave: () => import('@/components/reactbits/PlasmaWave'),
  evilEye: () => import('@/components/reactbits/EvilEye'),
  lightPillar: () => import('@/components/reactbits/LightPillar'),
  prismaticBurst: () => import('@/components/reactbits/PrismaticBurst'),
  faultyTerminal: () => import('@/components/reactbits/FaultyTerminal'),
  letterGlitch: () => import('@/components/reactbits/LetterGlitch'),
  shapeGrid: () => import('@/components/reactbits/ShapeGrid'),
  magicRings: () => import('@/components/reactbits/MagicRings'),
  laserFlow: () => import('@/components/reactbits/LaserFlow'),
  antigravity: () => import('@/components/reactbits/Antigravity'),
}

/** Lazy-loaded React Bits background components, keyed by BackgroundId. */
export const BG_COMPONENTS: Record<BackgroundId, BgComponent | null> = {
  none: null,
  // Derived from BG_LOADERS so the two can never drift apart — a new
  // background is one line, in one place.
  ...(Object.fromEntries(
    Object.entries(BG_LOADERS).map(([id, load]) => [id, lazy(load)]),
  ) as Record<Exclude<BackgroundId, 'none'>, BgComponent>),
}
