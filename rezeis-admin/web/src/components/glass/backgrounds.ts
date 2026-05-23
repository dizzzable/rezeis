/**
 * Backgrounds — shared lazy-loaded React Bits background components.
 * Single source of truth for both `GlassBackground` (production) and
 * `glass-settings-card` (preview). Adding a new BackgroundId in the
 * store requires adding an entry here too — the typed Record forces
 * the compiler to enforce this.
 */
import { lazy, type LazyExoticComponent, type ComponentType } from 'react'
import type { BackgroundId } from '@/lib/theme/glass-store'

type BgComponent = LazyExoticComponent<ComponentType<Record<string, unknown>>>

/** Lazy-loaded React Bits background components, keyed by BackgroundId. */
export const BG_COMPONENTS: Record<BackgroundId, BgComponent | null> = {
  none: null,
  silk: lazy(() => import('@/components/reactbits/Silk')),
  aurora: lazy(() => import('@/components/reactbits/Aurora')),
  threads: lazy(() => import('@/components/reactbits/Threads')),
  waves: lazy(() => import('@/components/reactbits/Waves')),
  iridescence: lazy(() => import('@/components/reactbits/Iridescence')),
  galaxy: lazy(() => import('@/components/reactbits/Galaxy')),
  particles: lazy(() => import('@/components/reactbits/Particles')),
  dotGrid: lazy(() => import('@/components/reactbits/DotGrid')),
  liquidChrome: lazy(() => import('@/components/reactbits/LiquidChrome')),
  balatro: lazy(() => import('@/components/reactbits/Balatro')),
  beams: lazy(() => import('@/components/reactbits/Beams')),
  plasma: lazy(() => import('@/components/reactbits/Plasma')),
  grainient: lazy(() => import('@/components/reactbits/Grainient')),
  softAurora: lazy(() => import('@/components/reactbits/SoftAurora')),
  dither: lazy(() => import('@/components/reactbits/Dither')),
  lineWaves: lazy(() => import('@/components/reactbits/LineWaves')),
  rippleGrid: lazy(() => import('@/components/reactbits/RippleGrid')),
  lightning: lazy(() => import('@/components/reactbits/Lightning')),
  radar: lazy(() => import('@/components/reactbits/Radar')),
}
