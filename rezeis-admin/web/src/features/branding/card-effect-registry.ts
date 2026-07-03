/**
 * Card-effect registry (WEB Reiwa configurator).
 * ──────────────────────────────────────────────
 * The animated ReactBits effects an operator can place BEHIND the reiwa
 * subscription card. Mirrors the reiwa SPA registry
 * (`reiwa/web/src/components/reactbits/registry.ts`) — keep both in lockstep.
 *
 * Only the dependency-light effects (ogl + canvas + fiber) plus the WebGL2
 * Paper Shaders (`paper*`) are exposed. Each effect reuses the existing admin
 * `components/reactbits/<Name>` so the configurator preview renders the REAL
 * effect, and the control defs drive the tunable parameter UI + the params we
 * persist to branding.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

import type { ControlDef } from '@/features/appearance/background-controls'

export type CardEffectId =
  | 'aurora'
  | 'threads'
  | 'softAurora'
  | 'rippleGrid'
  | 'radar'
  | 'plasma'
  | 'particles'
  | 'liquidChrome'
  | 'lineWaves'
  | 'iridescence'
  | 'grainient'
  | 'galaxy'
  | 'balatro'
  | 'waves'
  | 'silk'
  | 'beams'
  | 'dither'
  | 'paperMesh'
  | 'paperWarp'
  | 'paperGrain'
  | 'paperDither'
  | 'paperSwirl'
  | 'paperMetaballs'

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
}

export interface CardEffectDef {
  id: CardEffectId
  /** Default English display name — also i18n fallback. */
  name: string
  controls: ControlDef[]
}

/** Tunable params per effect (subset of the full appearance registry). */
export const CARD_EFFECT_REGISTRY: readonly CardEffectDef[] = [
  {
    id: 'aurora', name: 'Aurora',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'blend', label: 'Blend', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'colorStops', label: 'Colors', type: 'colorArray', count: 3, default: ['#5227FF', '#7cff67', '#5227FF'] },
    ],
  },
  {
    id: 'threads', name: 'Threads',
    controls: [
      { prop: 'color', label: 'Color', type: 'rgbColor', default: [1, 1, 1] },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'distance', label: 'Distance', type: 'slider', min: 0, max: 2, step: 0.1, default: 0 },
    ],
  },
  {
    id: 'softAurora', name: 'Soft Aurora',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#f7f7f7' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#e100ff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 0.6 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.5, max: 5, step: 0.1, default: 1.5 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'noiseFrequency', label: 'Noise Frequency', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2.5 },
    ],
  },
  {
    id: 'rippleGrid', name: 'Ripple Grid',
    controls: [
      { prop: 'gridColor', label: 'Grid Color', type: 'color', default: '#ffffff' },
      { prop: 'rippleIntensity', label: 'Ripple Intensity', type: 'slider', min: 0.01, max: 0.2, step: 0.01, default: 0.05 },
      { prop: 'gridSize', label: 'Grid Size', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 0.5, step: 0.05, default: 0.1 },
      { prop: 'enableRainbow', label: 'Rainbow', type: 'toggle', default: false },
    ],
  },
  {
    id: 'radar', name: 'Radar',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#9f29ff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'ringCount', label: 'Rings', type: 'slider', min: 3, max: 20, step: 1, default: 10 },
      { prop: 'spokeCount', label: 'Spokes', type: 'slider', min: 3, max: 20, step: 1, default: 10 },
      { prop: 'sweepSpeed', label: 'Sweep Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'plasma', name: 'Plasma',
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'particles', name: 'Particles',
    controls: [
      { prop: 'particleColors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffffff', '#ffffff', '#ffffff'] },
      { prop: 'particleCount', label: 'Count', type: 'slider', min: 50, max: 500, step: 10, default: 200 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1 },
      { prop: 'particleBaseSize', label: 'Size', type: 'slider', min: 10, max: 300, step: 10, default: 100 },
    ],
  },
  {
    id: 'liquidChrome', name: 'Liquid Chrome',
    controls: [
      { prop: 'baseColor', label: 'Base Color', type: 'rgbColor', default: [0.1, 0.1, 0.1] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.2 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.5 },
      { prop: 'frequencyX', label: 'Frequency X', type: 'slider', min: 1, max: 10, step: 0.5, default: 3 },
      { prop: 'frequencyY', label: 'Frequency Y', type: 'slider', min: 1, max: 10, step: 0.5, default: 2 },
    ],
  },
  {
    id: 'lineWaves', name: 'Line Waves',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#ffffff' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#ffffff' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.3 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.2 },
      { prop: 'warpIntensity', label: 'Warp', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'iridescence', name: 'Iridescence',
    controls: [
      { prop: 'color', label: 'Color', type: 'rgbColor', default: [1, 1, 1] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1 },
    ],
  },
  {
    id: 'grainient', name: 'Grainient',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#FF9FFC' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#5227FF' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#B497CF' },
      { prop: 'timeSpeed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.25 },
      { prop: 'grainAmount', label: 'Grain', type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.1 },
      { prop: 'warpStrength', label: 'Warp', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
    ],
  },
  {
    id: 'galaxy', name: 'Galaxy',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'density', label: 'Density', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'hueShift', label: 'Hue Shift', type: 'slider', min: 0, max: 360, step: 5, default: 140 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
      { prop: 'twinkleIntensity', label: 'Twinkle', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
    ],
  },
  {
    id: 'balatro', name: 'Balatro',
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#DE443B' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#006BB4' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#162325' },
      { prop: 'spinSpeed', label: 'Spin Speed', type: 'slider', min: 0.5, max: 15, step: 0.5, default: 7 },
      { prop: 'contrast', label: 'Contrast', type: 'slider', min: 1, max: 8, step: 0.5, default: 3.5 },
      { prop: 'lighting', label: 'Lighting', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.4 },
    ],
  },
  {
    id: 'waves', name: 'Waves',
    controls: [
      { prop: 'lineColor', label: 'Line Color', type: 'color', default: '#ffffff' },
      { prop: 'waveSpeedX', label: 'Speed X', type: 'slider', min: 0.001, max: 0.05, step: 0.001, default: 0.0125 },
      { prop: 'waveAmpX', label: 'Amplitude X', type: 'slider', min: 5, max: 100, step: 5, default: 32 },
      { prop: 'xGap', label: 'X Gap', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      { prop: 'yGap', label: 'Y Gap', type: 'slider', min: 5, max: 60, step: 1, default: 32 },
    ],
  },
  {
    id: 'silk', name: 'Silk',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 10, step: 0.1, default: 5 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'color', label: 'Color', type: 'color', default: '#7b7481' },
      { prop: 'noiseIntensity', label: 'Noise Intensity', type: 'slider', min: 0, max: 5, step: 0.1, default: 1.5 },
      { prop: 'rotation', label: 'Rotation', type: 'slider', min: -180, max: 180, step: 1, default: 0 },
    ],
  },
  {
    id: 'beams', name: 'Beams',
    controls: [
      { prop: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2 },
      { prop: 'beamWidth', label: 'Beam Width', type: 'slider', min: 0.5, max: 5, step: 0.5, default: 2 },
      { prop: 'beamNumber', label: 'Beam Count', type: 'slider', min: 4, max: 30, step: 1, default: 12 },
      { prop: 'noiseIntensity', label: 'Noise', type: 'slider', min: 0, max: 5, step: 0.25, default: 1.75 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.2 },
    ],
  },
  {
    id: 'dither', name: 'Dither',
    controls: [
      { prop: 'waveColor', label: 'Color', type: 'rgbColor', default: [0.5, 0.5, 0.5] },
      { prop: 'waveSpeed', label: 'Speed', type: 'slider', min: 0.01, max: 0.2, step: 0.01, default: 0.05 },
      { prop: 'waveFrequency', label: 'Frequency', type: 'slider', min: 1, max: 10, step: 0.5, default: 3 },
      { prop: 'waveAmplitude', label: 'Amplitude', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { prop: 'pixelSize', label: 'Pixel Size', type: 'slider', min: 1, max: 8, step: 1, default: 2 },
      { prop: 'colorNum', label: 'Color Levels', type: 'slider', min: 2, max: 8, step: 1, default: 4 },
    ],
  },
  {
    id: 'paperMesh', name: 'Mesh Gradient',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'distortion', label: 'Distortion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.8 },
      { prop: 'swirl', label: 'Swirl', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1 },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 4, default: ['#e0eaff', '#241d9a', '#f75092', '#9f50d3'] },
    ],
  },
  {
    id: 'paperWarp', name: 'Warp',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['checks', 'stripes', 'edge'], default: 'checks' },
      { prop: 'proportion', label: 'Proportion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.45 },
      { prop: 'softness', label: 'Softness', type: 'slider', min: 0, max: 2, step: 0.05, default: 1 },
      { prop: 'distortion', label: 'Distortion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.25 },
      { prop: 'swirl', label: 'Swirl', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.8 },
      { prop: 'swirlIterations', label: 'Swirl Iterations', type: 'slider', min: 1, max: 20, step: 1, default: 10 },
      { prop: 'shapeScale', label: 'Shape Scale', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1 },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 4, default: ['#121212', '#9470ff', '#121212', '#8838ff'] },
    ],
  },
  {
    id: 'paperGrain', name: 'Grain Gradient',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['corners', 'wave', 'dots', 'truchet', 'ripple', 'blob'], default: 'corners' },
      { prop: 'softness', label: 'Softness', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'noise', label: 'Noise', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.25 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 4, default: ['#7300ff', '#eba8ff', '#00bfff', '#2a00ff'] },
    ],
  },
  {
    id: 'paperDither', name: 'Dithering',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['sphere', 'wave', 'dots', 'ripple', 'swirl', 'warp'], default: 'sphere' },
      { prop: 'type', label: 'Dither Type', type: 'select', options: ['2x2', '4x4', '8x8', 'random'], default: '4x4' },
      { prop: 'size', label: 'Pixel Size', type: 'slider', min: 1, max: 12, step: 1, default: 2 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.6 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colorFront', label: 'Foreground', type: 'color', default: '#00b2ff' },
    ],
  },
  {
    id: 'paperSwirl', name: 'Swirl',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0, max: 2, step: 0.05, default: 0.32 },
      { prop: 'bandCount', label: 'Bands', type: 'slider', min: 1, max: 12, step: 1, default: 4 },
      { prop: 'twist', label: 'Twist', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1 },
      { prop: 'center', label: 'Center', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.2 },
      { prop: 'proportion', label: 'Proportion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'softness', label: 'Softness', type: 'slider', min: 0, max: 1, step: 0.05, default: 0 },
      { prop: 'noiseFrequency', label: 'Noise Frequency', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.4 },
      { prop: 'noise', label: 'Noise', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.2 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffd1d1', '#ff8a8a', '#660000'] },
    ],
  },
  {
    id: 'paperMetaballs', name: 'Metaballs',
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0, max: 3, step: 0.1, default: 1 },
      { prop: 'count', label: 'Count', type: 'slider', min: 1, max: 20, step: 1, default: 10 },
      { prop: 'size', label: 'Size', type: 'slider', min: 0.1, max: 1, step: 0.05, default: 0.83 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.5, max: 4, step: 0.1, default: 1 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 5, default: ['#6e33cc', '#ff5500', '#ffc105', '#ffc800', '#f585ff'] },
    ],
  },
]

export function getCardEffectDef(id: string): CardEffectDef | undefined {
  return CARD_EFFECT_REGISTRY.find((e) => e.id === id)
}

export function getCardEffectDefaults(id: string): Record<string, unknown> {
  const def = getCardEffectDef(id)
  if (!def) return {}
  const props: Record<string, unknown> = {}
  for (const c of def.controls) props[c.prop] = c.default
  return props
}
