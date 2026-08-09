/**
 * Every animated card background the panel offers, described once.
 *
 * The same list of effect names used to live in six hand-kept places across two
 * repositories: this registry, the form schema's allowed values, the backend's
 * validation list, the set needing WebGL2, the set drawing on a plain canvas,
 * and the fallback palettes. Adding one effect meant finding all six, and
 * missing one stayed invisible until a preview went grey or an operator's save
 * was rejected for a value the panel itself had offered.
 *
 * Each effect is stated once here and everything else is derived. The record's
 * KEY is the effect id, which is what gives `CardEffectId` its members — there
 * is no separate list of names left to fall out of step with.
 *
 * Deliberately free of React. The components live in `card-effect-registry.ts`,
 * and the backend's contract test imports this file directly to check that its
 * own validation list still matches what the panel offers; neither would work
 * if a shader import sat at the top.
 */

import type { ControlDef } from '@/features/appearance/background-controls'

/**
 * What an effect needs from the device in order to paint.
 *
 * `canvas2d` is not a lesser tier but a different one: those effects need no
 * GPU context at all, so they run where a shader cannot start and they do not
 * consume one of the handful of live WebGL contexts a mobile browser allows.
 * Filing a canvas effect as `webgl1` costs it exactly the devices it was chosen
 * for, in the preview and in the cabinet alike.
 */
export type CardEffectRenderer = 'canvas2d' | 'webgl1' | 'webgl2'

export interface CardEffectEntry {
  /** Default English display name — also the i18n fallback. */
  name: string
  renderer: CardEffectRenderer
  /**
   * File name under `components/reactbits/originkit/`, for effects vendored
   * from there. `originkit-manifest.test.ts` uses it to prove that every effect
   * the panel offers actually has its component copied into this tree — an
   * entry whose component was never vendored is a tile that draws nothing, and
   * nobody finds that by clicking thirty tiles.
   */
  componentFile?: string
  /** Colours the static stand-in uses when the real renderer cannot run. */
  palette: readonly string[]
  /**
   * Set when the shader can emit colours outside the palette it was given —
   * additive blending, glow, procedural noise, post-contrast. Contrast analysis
   * then has to assume both display extremes rather than trusting the
   * operator's uniforms.
   */
  fullOutputGamut?: true
  /**
   * The operator-tunable parameters, and the only place their defaults live:
   * `getCardEffectDefaults` reads them straight off this list, so a control
   * without a sensible default is a control that ships without one.
   *
   * A slider must not reach zero where zero STOPS THE PICTURE. Twelve did:
   * their renderer multiplies elapsed time by that uniform and nothing else
   * moves, so zero did not pause the animation — it froze the image while the
   * canvas kept asking for a frame, spending a phone's whole frame budget to
   * redraw a still picture. The operator got there by dragging to the end of a
   * slider whose label said "Speed", with nothing to say the card had stopped
   * rather than that the effect was broken. The same applies to any slider
   * whose zero end means "draw nothing" (`snowfall.opacityMax`).
   *
   * That is the whole test, and it is narrower than "a slider that drives
   * motion": several speed-named sliders scale ONE term of an effect that has
   * other motion of its own, and their zero end is a look rather than a stop.
   * Six such sliders still reach zero and are meant to; each is listed in
   * `ZERO_MINIMUM_MOTION_SLIDERS` below with the line of its component that
   * settles it, because "zero freezes it" is a claim about the component, not
   * about the catalogue, and it has been argued both ways from memory.
   *
   * `card-effect-motion-sliders.test.ts` fails if a `speed`/`spin`-named slider
   * reaches zero without an entry there, so this paragraph cannot go back to
   * describing a sweep that did not happen.
   */
  controls: ControlDef[]
}

/**
 * Every `speed`/`spin`-named slider whose minimum is zero, and why zero is safe.
 *
 * Keyed `effect.prop`. A previous review argued two of these from memory and
 * got both right, but the components had been rewritten under the argument; the
 * deciding line is quoted here so the next reader does not have to re-derive it.
 * Verified against the vendored sources under `components/reactbits/originkit/`:
 *
 *  - `stardust.particleSpeed` ("Drift") scales the PER-PARTICLE random velocity
 *    only: `vx: (Math.random() - 0.5) * velocityMultiplier`. The shared
 *    directional drift (`movement`, default 6) and the flicker (`speed`, min 1)
 *    are untouched, so the field still moves and still twinkles at zero.
 *  - `pulseLines.speed` ("Wave Spread") is not a rate at all — it is the CSS
 *    animation-delay span, `'--delay': `${(delayFactor * speed) / 50}s``. Zero
 *    means every line pulses in unison, at the same rate as before.
 *  - `risingLines.riseSpeed` is a multiplier ON TOP of each spark's own upward
 *    velocity: `const effVy = bVY[i] * (1.0 + riseSpeedMul)`. Zero is 1×, the
 *    slowest rise the effect offers, not a stop.
 *  - `starBurst.twinkleSpeed` scales only the brightness oscillation,
 *    `0.7 + 0.3 * Math.sin(timeSec * safeTwinkleSpeed * 6 + pPhase[i])`. The
 *    pulses keep travelling their spokes on `speed` (min 1); zero is a steady
 *    ray rather than a frozen one.
 *  - `cosmicOrb.spin` scales the sphere's rotation, which was deliberately
 *    given its own wall-clock in the rewrite: `const tNebula = tReal *
 *    cfg.speed` runs the nebula whatever Spin says. Zero is "no rotation", a
 *    look the split was made to allow.
 *  - `blackhole.pullSpeed` ships zero as its DEFAULT, which is the older and
 *    simpler reason: the shipped card is the proof that zero is a real setting.
 */
export const ZERO_MINIMUM_MOTION_SLIDERS: Readonly<Record<string, string>> = {
  'stardust.particleSpeed': 'per-particle drift only; shared drift and flicker keep running',
  'pulseLines.speed': 'an animation-delay span, not a rate; zero pulses the lines in unison',
  'risingLines.riseSpeed': 'a multiplier on top of each spark\'s own velocity; zero is 1×',
  'starBurst.twinkleSpeed': 'brightness oscillation only; the pulses still travel on `speed`',
  'cosmicOrb.spin': 'sphere rotation only; the nebula runs on its own clock',
  'blackhole.pullSpeed': 'zero is the shipped default',
}

export const CARD_EFFECT_CATALOG = {
  aurora: {
    name: 'Aurora',
    renderer: 'webgl1',
    palette: ['#5227FF', '#7CFF67', '#5227FF'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'blend', label: 'Blend', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'colorStops', label: 'Colors', type: 'colorArray', count: 3, default: ['#5227FF', '#7cff67', '#5227FF'] },
    ]
  },
  threads: {
    name: 'Threads',
    renderer: 'webgl1',
    palette: ['#ffffff'],
    controls: [
      { prop: 'color', label: 'Color', type: 'rgbColor', default: [1, 1, 1] },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'distance', label: 'Distance', type: 'slider', min: 0, max: 2, step: 0.1, default: 0 },
    ]
  },
  softAurora: {
    name: 'Soft Aurora',
    renderer: 'webgl1',
    palette: ['#f7f7f7', '#e100ff'],
    fullOutputGamut: true,
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#f7f7f7' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#e100ff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 0.6 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.5, max: 5, step: 0.1, default: 1.5 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'noiseFrequency', label: 'Noise Frequency', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2.5 },
    ]
  },
  rippleGrid: {
    name: 'Ripple Grid',
    renderer: 'webgl1',
    palette: ['#ffffff'],
    fullOutputGamut: true,
    controls: [
      { prop: 'gridColor', label: 'Grid Color', type: 'color', default: '#ffffff' },
      { prop: 'rippleIntensity', label: 'Ripple Intensity', type: 'slider', min: 0.01, max: 0.2, step: 0.01, default: 0.05 },
      { prop: 'gridSize', label: 'Grid Size', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 0.5, step: 0.05, default: 0.1 },
      { prop: 'enableRainbow', label: 'Rainbow', type: 'toggle', default: false },
    ]
  },
  radar: {
    name: 'Radar',
    renderer: 'webgl1',
    palette: ['#9f29ff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#9f29ff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'ringCount', label: 'Rings', type: 'slider', min: 3, max: 20, step: 1, default: 10 },
      { prop: 'spokeCount', label: 'Spokes', type: 'slider', min: 3, max: 20, step: 1, default: 10 },
      { prop: 'sweepSpeed', label: 'Sweep Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
    ]
  },
  plasma: {
    name: 'Plasma',
    renderer: 'webgl2',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
    ]
  },
  particles: {
    name: 'Particles',
    renderer: 'webgl1',
    palette: ['#ffffff'],
    fullOutputGamut: true,
    controls: [
      { prop: 'particleColors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffffff', '#ffffff', '#ffffff'] },
      { prop: 'particleCount', label: 'Count', type: 'slider', min: 50, max: 500, step: 10, default: 200 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1 },
      { prop: 'particleBaseSize', label: 'Size', type: 'slider', min: 10, max: 300, step: 10, default: 100 },
    ]
  },
  liquidChrome: {
    name: 'Liquid Chrome',
    renderer: 'webgl1',
    palette: ['#1a1a1a', '#000000', '#ffffff'],
    fullOutputGamut: true,
    controls: [
      { prop: 'baseColor', label: 'Base Color', type: 'rgbColor', default: [0.1, 0.1, 0.1] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.2 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.5 },
      { prop: 'frequencyX', label: 'Frequency X', type: 'slider', min: 1, max: 10, step: 0.5, default: 3 },
      { prop: 'frequencyY', label: 'Frequency Y', type: 'slider', min: 1, max: 10, step: 0.5, default: 2 },
    ]
  },
  lineWaves: {
    name: 'Line Waves',
    renderer: 'webgl1',
    palette: ['#ffffff'],
    fullOutputGamut: true,
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#ffffff' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#ffffff' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.3 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.2 },
      { prop: 'warpIntensity', label: 'Warp', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
    ]
  },
  iridescence: {
    name: 'Iridescence',
    renderer: 'webgl1',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'color', label: 'Color', type: 'rgbColor', default: [1, 1, 1] },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'amplitude', label: 'Amplitude', type: 'slider', min: 0.01, max: 1, step: 0.01, default: 0.1 },
    ]
  },
  grainient: {
    name: 'Grainient',
    renderer: 'webgl2',
    palette: ['#ff9ffc', '#5227ff', '#b497cf'],
    fullOutputGamut: true,
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#FF9FFC' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#5227FF' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#B497CF' },
      { prop: 'timeSpeed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.05, default: 0.25 },
      { prop: 'grainAmount', label: 'Grain', type: 'slider', min: 0, max: 0.5, step: 0.01, default: 0.1 },
      { prop: 'warpStrength', label: 'Warp', type: 'slider', min: 0, max: 5, step: 0.1, default: 1 },
      { prop: 'contrast', label: 'Contrast', type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 1.5 },
    ]
  },
  galaxy: {
    name: 'Galaxy',
    renderer: 'webgl1',
    palette: ['#ffffff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'density', label: 'Density', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'hueShift', label: 'Hue Shift', type: 'slider', min: 0, max: 360, step: 5, default: 140 },
      { prop: 'glowIntensity', label: 'Glow', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
      { prop: 'twinkleIntensity', label: 'Twinkle', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.3 },
    ]
  },
  balatro: {
    name: 'Balatro',
    renderer: 'webgl1',
    palette: ['#de443b', '#006bb4', '#162325'],
    fullOutputGamut: true,
    controls: [
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#DE443B' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#006BB4' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#162325' },
      { prop: 'spinSpeed', label: 'Spin Speed', type: 'slider', min: 0.5, max: 15, step: 0.5, default: 7 },
      { prop: 'contrast', label: 'Contrast', type: 'slider', min: 1, max: 8, step: 0.5, default: 3.5 },
      { prop: 'lighting', label: 'Lighting', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.4 },
    ]
  },
  waves: {
    name: 'Waves',
    renderer: 'canvas2d',
    palette: ['#ffffff', '#00000000'],
    controls: [
      { prop: 'lineColor', label: 'Line Color', type: 'color', default: '#ffffff' },
      // Steps chosen so the shipped defaults sit ON the grid. A slider snaps to
      // `min + n * step`, so an off-grid default moves the moment it is touched
      // — the operator drags a hair and the value jumps somewhere they did not
      // ask for, and the card they were shown before the drag can no longer be
      // reached from the panel at all. 0.0125 is 23 steps of 0.0005 above the
      // minimum; 32 is 27 steps of 1 above it. Both maxima stay reachable.
      { prop: 'waveSpeedX', label: 'Speed X', type: 'slider', min: 0.001, max: 0.05, step: 0.0005, default: 0.0125 },
      { prop: 'waveAmpX', label: 'Amplitude X', type: 'slider', min: 5, max: 100, step: 1, default: 32 },
      { prop: 'xGap', label: 'X Gap', type: 'slider', min: 2, max: 30, step: 1, default: 10 },
      { prop: 'yGap', label: 'Y Gap', type: 'slider', min: 5, max: 60, step: 1, default: 32 },
    ]
  },
  silk: {
    name: 'Silk',
    renderer: 'webgl2',
    palette: ['#7b7481'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 10, step: 0.1, default: 5 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'color', label: 'Color', type: 'color', default: '#7b7481' },
      { prop: 'noiseIntensity', label: 'Noise Intensity', type: 'slider', min: 0, max: 5, step: 0.1, default: 1.5 },
      { prop: 'rotation', label: 'Rotation', type: 'slider', min: -180, max: 180, step: 1, default: 0 },
    ]
  },
  beams: {
    name: 'Beams',
    renderer: 'webgl2',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'lightColor', label: 'Light Color', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.5, max: 10, step: 0.5, default: 2 },
      { prop: 'beamWidth', label: 'Beam Width', type: 'slider', min: 0.5, max: 5, step: 0.5, default: 2 },
      { prop: 'beamNumber', label: 'Beam Count', type: 'slider', min: 4, max: 30, step: 1, default: 12 },
      { prop: 'noiseIntensity', label: 'Noise', type: 'slider', min: 0, max: 5, step: 0.25, default: 1.75 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.2 },
    ]
  },
  dither: {
    name: 'Dither',
    renderer: 'webgl2',
    palette: ['#808080', '#000000'],
    controls: [
      { prop: 'waveColor', label: 'Color', type: 'rgbColor', default: [0.5, 0.5, 0.5] },
      { prop: 'waveSpeed', label: 'Speed', type: 'slider', min: 0.01, max: 0.2, step: 0.01, default: 0.05 },
      { prop: 'waveFrequency', label: 'Frequency', type: 'slider', min: 1, max: 10, step: 0.5, default: 3 },
      { prop: 'waveAmplitude', label: 'Amplitude', type: 'slider', min: 0.05, max: 1, step: 0.05, default: 0.3 },
      { prop: 'pixelSize', label: 'Pixel Size', type: 'slider', min: 1, max: 8, step: 1, default: 2 },
      { prop: 'colorNum', label: 'Color Levels', type: 'slider', min: 2, max: 8, step: 1, default: 4 },
    ]
  },
  paperMesh: {
    name: 'Mesh Gradient',
    renderer: 'webgl2',
    palette: ['#e0eaff', '#241d9a', '#f75092', '#9f50d3'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'distortion', label: 'Distortion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.8 },
      { prop: 'swirl', label: 'Swirl', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1 },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 4, default: ['#e0eaff', '#241d9a', '#f75092', '#9f50d3'] },
    ]
  },
  paperWarp: {
    name: 'Warp',
    renderer: 'webgl2',
    palette: ['#121212', '#9470ff', '#8838ff'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 1 },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['checks', 'stripes', 'edge'], default: 'checks' },
      { prop: 'proportion', label: 'Proportion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.45 },
      { prop: 'softness', label: 'Softness', type: 'slider', min: 0, max: 1, step: 0.05, default: 1 },
      { prop: 'distortion', label: 'Distortion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.25 },
      { prop: 'swirl', label: 'Swirl', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.8 },
      { prop: 'swirlIterations', label: 'Swirl Iterations', type: 'slider', min: 1, max: 20, step: 1, default: 10 },
      { prop: 'shapeScale', label: 'Shape Scale', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1 },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 4, default: ['#121212', '#9470ff', '#121212', '#8838ff'] },
    ]
  },
  paperGrain: {
    name: 'Grain Gradient',
    renderer: 'webgl2',
    palette: ['#000000', '#7300ff', '#eba8ff', '#00bfff', '#2a00ff'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['corners', 'wave', 'dots', 'truchet', 'ripple', 'blob'], default: 'corners' },
      { prop: 'softness', label: 'Softness', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'noise', label: 'Noise', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.25 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 4, default: ['#7300ff', '#eba8ff', '#00bfff', '#2a00ff'] },
    ]
  },
  paperDither: {
    name: 'Dithering',
    renderer: 'webgl2',
    palette: ['#000000', '#00b2ff'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['sphere', 'wave', 'dots', 'ripple', 'swirl', 'warp'], default: 'sphere' },
      { prop: 'type', label: 'Dither Type', type: 'select', options: ['2x2', '4x4', '8x8', 'random'], default: '4x4' },
      { prop: 'size', label: 'Pixel Size', type: 'slider', min: 1, max: 12, step: 1, default: 2 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.1, max: 2, step: 0.1, default: 0.6 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colorFront', label: 'Foreground', type: 'color', default: '#00b2ff' },
    ]
  },
  paperSwirl: {
    name: 'Swirl',
    renderer: 'webgl2',
    palette: ['#000000', '#ffd1d1', '#ff8a8a', '#660000'],
    controls: [
      // 0.32 is 27 steps of 0.01 above the minimum; on the old 0.05 grid the
      // first drag snapped it to 0.30 or 0.35.
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.05, max: 2, step: 0.01, default: 0.32 },
      { prop: 'bandCount', label: 'Bands', type: 'slider', min: 1, max: 12, step: 1, default: 4 },
      { prop: 'twist', label: 'Twist', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.1 },
      { prop: 'center', label: 'Center', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.2 },
      { prop: 'proportion', label: 'Proportion', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.5 },
      { prop: 'softness', label: 'Softness', type: 'slider', min: 0, max: 1, step: 0.05, default: 0 },
      { prop: 'noiseFrequency', label: 'Noise Frequency', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.4 },
      { prop: 'noise', label: 'Noise', type: 'slider', min: 0, max: 1, step: 0.05, default: 0.2 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffd1d1', '#ff8a8a', '#660000'] },
    ]
  },
  paperMetaballs: {
    name: 'Metaballs',
    renderer: 'webgl2',
    palette: ['#000000', '#6e33cc', '#ff5500', '#ffc105', '#f585ff'],
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.1, max: 3, step: 0.1, default: 1 },
      { prop: 'count', label: 'Count', type: 'slider', min: 1, max: 20, step: 1, default: 10 },
      // 0.83 is 73 steps of 0.01 above the minimum; the old 0.05 grid held no
      // such value, so the first drag snapped it to 0.80 or 0.85.
      { prop: 'size', label: 'Size', type: 'slider', min: 0.1, max: 1, step: 0.01, default: 0.83 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 0.5, max: 4, step: 0.1, default: 1 },
      { prop: 'colorBack', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 5, default: ['#6e33cc', '#ff5500', '#ffc105', '#ffc800', '#f585ff'] },
    ]
  },

  // ── Originkit ─────────────────────────────────────────────────────────
  // Vendored from `components/reactbits/originkit/`, which is byte-frozen
  // against the cabinet's copy by `originkit-manifest.test.ts`. Most of
  // these draw on a plain canvas and so run where a shader cannot start —
  // which is the point of adding them.
  snowfall: {
    name: 'Snowfall',
    renderer: 'canvas2d',
    componentFile: 'Snowfall.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'count', label: 'Flakes', type: 'slider', min: 20, max: 400, step: 10, default: 160 },
      { prop: 'speedMin', label: 'Min Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 0.6 },
      { prop: 'speedMax', label: 'Max Speed', type: 'slider', min: 0.1, max: 5, step: 0.1, default: 2.4 },
      { prop: 'wind', label: 'Wind', type: 'slider', min: -3, max: 3, step: 0.1, default: 0 },
      { prop: 'windVariation', label: 'Wind Spread', type: 'slider', min: 0, max: 3, step: 0.1, default: 0.8 },
      { prop: 'sizeMin', label: 'Min Size', type: 'slider', min: 0.5, max: 6, step: 0.25, default: 1 },
      { prop: 'sizeMax', label: 'Max Size', type: 'slider', min: 0.5, max: 6, step: 0.25, default: 4 },
      // Snowfall reads these as an unordered pair — `alphaHi` is the MAX of the
      // two — so a card only goes empty when BOTH ends sit at zero, which the
      // old `min: 0` on each made two drags away with no warning between them.
      // Five percent is faint but present, so the pair can no longer name an
      // invisible snowfall at all.
      { prop: 'opacityMin', label: 'Min Opacity', type: 'slider', min: 5, max: 100, step: 5, default: 30 },
      { prop: 'opacityMax', label: 'Max Opacity', type: 'slider', min: 5, max: 100, step: 5, default: 90 },
      { prop: 'direction', label: 'Direction', type: 'select', options: ['down', 'up'], default: 'down' },
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
    ]
  },
  stardust: {
    name: 'Stardust',
    renderer: 'canvas2d',
    componentFile: 'Stardust.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'particleColor', label: 'Particle Color', type: 'color', default: '#FFFFFF' },
      { prop: 'background', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'particleDensity', label: 'Density', type: 'slider', min: 1, max: 8, step: 0.25, default: 4 },
      { prop: 'minSize', label: 'Min Size', type: 'slider', min: 0.5, max: 5, step: 0.25, default: 1.5 },
      { prop: 'maxSize', label: 'Max Size', type: 'slider', min: 0.5, max: 5, step: 0.25, default: 1 },
      { prop: 'speed', label: 'Flicker', type: 'slider', min: 1, max: 10, step: 0.5, default: 10 },
      { prop: 'particleSpeed', label: 'Drift', type: 'slider', min: 0, max: 10, step: 0.5, default: 1 },
      { prop: 'movement', label: 'Movement', type: 'slider', min: 0, max: 10, step: 0.5, default: 6 },
      { prop: 'angle', label: 'Angle', type: 'slider', min: 0, max: 360, step: 5, default: 180 },
    ]
  },
  asciiRain: {
    name: 'ASCII Rain',
    renderer: 'canvas2d',
    componentFile: 'AsciiRain.tsx',
    palette: ['#ffffff', '#f7ff00', '#000000'],
    controls: [
      { prop: 'headColor', label: 'Head Color', type: 'color', default: '#FFFFFF' },
      { prop: 'trailColor', label: 'Trail Color', type: 'color', default: '#F7FF00' },
      { prop: 'glyphSize', label: 'Glyph Size', type: 'slider', min: 8, max: 40, step: 1, default: 20 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 1, max: 20, step: 0.5, default: 6 },
      { prop: 'angle', label: 'Angle', type: 'slider', min: -90, max: 90, step: 5, default: 0 },
      { prop: 'density', label: 'Density', type: 'slider', min: 5, max: 55, step: 1, default: 50 },
      { prop: 'trail', label: 'Trail Length', type: 'slider', min: 3, max: 40, step: 1, default: 23 },
      { prop: 'shuffle', label: 'Shuffle', type: 'toggle', default: true },
      { prop: 'shuffleGlyphs', label: 'Shuffle Glyphs', type: 'text', maxLength: 48, default: 'ｱｲｳｴｵｶｷｸ0123456789ABCDEFｸｿﾝ' },
      { prop: 'glyphs', label: 'Static Glyphs', type: 'text', maxLength: 48, default: 'ｱｲｳｴｵｶｷｸ0123456789ABCDEFｸｿﾝ' },
    ]
  },
  asciiFlame: {
    name: 'ASCII Flame',
    renderer: 'canvas2d',
    componentFile: 'AsciiFlame.tsx',
    palette: ['#000000', '#b93608', '#ff8b18', '#ffc247'],
    controls: [
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 10, max: 100, step: 5, default: 100 },
      { prop: 'decay', label: 'Decay', type: 'slider', min: 5, max: 40, step: 1, default: 13 },
      { prop: 'turbulence', label: 'Turbulence', type: 'slider', min: 0, max: 100, step: 5, default: 30 },
      { prop: 'thickness', label: 'Fuel Rows', type: 'slider', min: 1, max: 8, step: 1, default: 1 },
      { prop: 'windDirection', label: 'Wind Direction', type: 'select', options: ['left', 'right'], default: 'right' },
      { prop: 'windForce', label: 'Wind Force', type: 'slider', min: 10, max: 100, step: 5, default: 10 },
      { prop: 'charset', label: 'Charset', type: 'select', options: ['classic', 'dense', 'blocks', 'minimal'], default: 'dense' },
      { prop: 'palette', label: 'Palette', type: 'select', options: ['mono', 'color', 'custom'], default: 'custom' },
      { prop: 'shades', label: 'Ramp', type: 'colorArray', count: 7, default: ['#411205', '#7c2105', '#b93608', '#e85b0c', '#ff8b18', '#ffc247', '#fff1aa'] },
      { prop: 'sparkColor', label: 'Spark Color', type: 'color', default: '#FF3030' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'embers', label: 'Embers', type: 'toggle', default: true },
      { prop: 'sparks', label: 'Sparks', type: 'toggle', default: true },
      { prop: 'pulse', label: 'Pulse', type: 'toggle', default: false },
    ]
  },
  characterWaves: {
    name: 'Character Waves',
    renderer: 'canvas2d',
    componentFile: 'CharacterWaves.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'characters', label: 'Glyph Ramp', type: 'text', maxLength: 48, default: ' .:-+*=%@#' },
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { prop: 'background', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'elementSize', label: 'Cell Size', type: 'slider', min: 12, max: 48, step: 1, default: 16 },
      { prop: 'direction', label: 'Direction', type: 'select', options: ['left', 'right', 'top', 'bottom'], default: 'left' },
      { prop: 'fontWeight', label: 'Weight', type: 'select', options: ['300', '400', '500', '600', '700', '800'], default: '400' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 5, max: 100, step: 5, default: 20 },
      { prop: 'waveTension', label: 'Tension', type: 'slider', min: 1, max: 20, step: 0.5, default: 5 },
      { prop: 'noiseScale', label: 'Noise Scale', type: 'slider', min: 1, max: 50, step: 1, default: 12 },
      { prop: 'intensity', label: 'Contrast', type: 'slider', min: 1, max: 30, step: 1, default: 10 },
      { prop: 'invert', label: 'Invert', type: 'toggle', default: false },
      { prop: 'hasCursorInteraction', label: 'Ripple', type: 'toggle', default: true },
      { prop: 'interactionIntensity', label: 'Ripple Strength', type: 'slider', min: 0, max: 50, step: 1, default: 15 },
      { prop: 'interactionRadius', label: 'Ripple Radius', type: 'slider', min: 40, max: 400, step: 10, default: 160 },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  blinkingSquares: {
    name: 'Blinking Squares',
    renderer: 'canvas2d',
    componentFile: 'BlinkingSquares.tsx',
    palette: ['#bb29ff', '#000000'],
    controls: [
      { prop: 'gridSize', label: 'Grid', type: 'slider', min: 8, max: 60, step: 2, default: 40 },
      { prop: 'fillPercent', label: 'Fill', type: 'slider', min: 10, max: 100, step: 5, default: 70 },
      { prop: 'colorMode', label: 'Color Mode', type: 'select', options: ['single', 'multiple'], default: 'single' },
      { prop: 'squareColor', label: 'Color', type: 'color', default: '#BB29FF' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#BB29FF', '#29D9FF', '#FF2975'] },
      { prop: 'twinkleSpeed', label: 'Twinkle Speed', type: 'slider', min: 1, max: 100, step: 1, default: 30 },
      { prop: 'opacity', label: 'Opacity', type: 'slider', min: 0.1, max: 1, step: 0.05, default: 1 },
      { prop: 'fadeDirection', label: 'Fade Toward', type: 'select', options: ['right', 'left', 'top', 'bottom', 'none'], default: 'right' },
      { prop: 'fadePercent', label: 'Fade Span', type: 'slider', min: 0, max: 100, step: 5, default: 100 },
      { prop: 'fadeIntensity', label: 'Fade Falloff', type: 'slider', min: 0, max: 100, step: 5, default: 25 },
      { prop: 'hasCursorInteraction', label: 'Halo', type: 'toggle', default: false },
      { prop: 'cursorRadius', label: 'Halo Radius', type: 'slider', min: 40, max: 400, step: 10, default: 140 },
      { prop: 'cursorBoost', label: 'Halo Strength', type: 'slider', min: 5, max: 100, step: 5, default: 60 },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  lineRipple: {
    name: 'Line Ripple',
    renderer: 'canvas2d',
    componentFile: 'LineRippleBackground.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'strokeColor', label: 'Line Color', type: 'color', default: '#FFFFFF' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'count', label: 'Density', type: 'slider', min: 10, max: 80, step: 1, default: 57 },
      { prop: 'movement', label: 'Movement', type: 'slider', min: 2, max: 100, step: 2, default: 24 },
      { prop: 'resolution', label: 'Line Length', type: 'slider', min: 1, max: 25, step: 1, default: 10 },
      { prop: 'hover', label: 'Cursor Bend', type: 'toggle', default: true },
      { prop: 'force', label: 'Bend Force', type: 'slider', min: 0, max: 10, step: 0.5, default: 4 },
    ]
  },
  pulseLines: {
    name: 'Pulse Lines',
    renderer: 'canvas2d',
    componentFile: 'PulseLines.tsx',
    palette: ['#ffffff', '#222222', '#000000'],
    controls: [
      { prop: 'type', label: 'Direction', type: 'select', options: ['vertical', 'horizontal'], default: 'vertical' },
      { prop: 'shape', label: 'Shape', type: 'select', options: ['line', 'circle', 'square'], default: 'line' },
      { prop: 'cornerRadius', label: 'Corner Radius', type: 'slider', min: 0, max: 6, step: 0.25, default: 0 },
      { prop: 'paletteCount', label: 'Palette Size', type: 'slider', min: 1, max: 5, step: 1, default: 1 },
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#FFFFFF' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#FFFFFF' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#FFFFFF' },
      { prop: 'color4', label: 'Color 4', type: 'color', default: '#FFFFFF' },
      { prop: 'color5', label: 'Color 5', type: 'color', default: '#FFFFFF' },
      { prop: 'lineColor', label: 'Line Color', type: 'color', default: '#222222' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      // 99 is not a multiple of 5; on the old grid the first drag snapped it to
      // 95 or 100.
      { prop: 'speed', label: 'Wave Spread', type: 'slider', min: 0, max: 200, step: 1, default: 99 },
      { prop: 'lineWidth', label: 'Line Width', type: 'slider', min: 1, max: 12, step: 0.5, default: 2 },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 8, max: 100, step: 2, default: 30 },
      { prop: 'scale', label: 'Dash Scale', type: 'slider', min: 0.5, max: 6, step: 0.1, default: 2.5 },
    ]
  },
  textWave: {
    name: 'Text Wave',
    renderer: 'canvas2d',
    componentFile: 'TextWave.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'gridText', label: 'Text', type: 'text', maxLength: 32, default: 'Text Wave' },
      { prop: 'paletteCount', label: 'Palette Size', type: 'slider', min: 1, max: 5, step: 1, default: 1 },
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#FFFFFF' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#FFFFFF' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#FFFFFF' },
      { prop: 'color4', label: 'Color 4', type: 'color', default: '#FFFFFF' },
      { prop: 'color5', label: 'Color 5', type: 'color', default: '#FFFFFF' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'fontFamily', label: 'Font', type: 'select', options: ['Inter', 'system-ui', 'sans-serif', 'serif', 'monospace'], default: 'Inter' },
      { prop: 'fontWeight', label: 'Weight', type: 'slider', min: 100, max: 900, step: 100, default: 400 },
      { prop: 'fontSize', label: 'Text Size', type: 'slider', min: 10, max: 48, step: 1, default: 14 },
      { prop: 'letterSpacing', label: 'Letter Spacing', type: 'slider', min: -2, max: 8, step: 0.5, default: 0 },
      // 61 is 56 steps of 1 above the minimum; on the old grid of 5 the first
      // drag snapped it to 60 or 65.
      { prop: 'speed', label: 'Speed', type: 'slider', min: 5, max: 200, step: 1, default: 61 },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 8, max: 40, step: 2, default: 10 },
      { prop: 'reverse', label: 'Reverse', type: 'toggle', default: true },
    ]
  },
  pixelCard: {
    name: 'Pixel Card',
    renderer: 'canvas2d',
    componentFile: 'PixelCard.tsx',
    palette: ['#ffffff', '#27272a', '#000000'],
    controls: [
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['rgba(255, 255, 255, 1)', 'rgba(255, 255, 255, 0.8)', 'rgba(255, 255, 255, 0.6)'] },
      { prop: 'appearFrom', label: 'Appear From', type: 'select', options: ['middle', 'top', 'bottom', 'left', 'right'], default: 'middle' },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 5, max: 24, step: 1, default: 6 },
      { prop: 'pixelSize', label: 'Pixel Size', type: 'slider', min: 1, max: 10, step: 0.5, default: 2 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 5, max: 100, step: 5, default: 80 },
      { prop: 'padding', label: 'Padding', type: 'slider', min: 0, max: 32, step: 2, default: 0 },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'borderColor', label: 'Border Color', type: 'color', default: '#27272a' },
      { prop: 'borderWidth', label: 'Border Width', type: 'slider', min: 0, max: 8, step: 1, default: 1 },
      { prop: 'radius', label: 'Radius', type: 'slider', min: 0, max: 48, step: 1, default: 25 },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  glitterWrap: {
    name: 'Glitter Wrap',
    renderer: 'canvas2d',
    componentFile: 'GlitterWrap.tsx',
    palette: ['#ffffff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'particleCount', label: 'Stars', type: 'slider', min: 100, max: 700, step: 25, default: 500 },
      { prop: 'color1', label: 'Color 1', type: 'color', default: '#ffffff' },
      { prop: 'color2', label: 'Color 2', type: 'color', default: '#ffffff' },
      { prop: 'color3', label: 'Color 3', type: 'color', default: '#ffffff' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 1, max: 15, step: 0.5, default: 5 },
      { prop: 'density', label: 'Spread', type: 'slider', min: 10, max: 100, step: 5, default: 100 },
      { prop: 'starSize', label: 'Star Size', type: 'slider', min: 2, max: 20, step: 1, default: 20 },
      { prop: 'focalDepth', label: 'Focal Depth', type: 'slider', min: 2, max: 30, step: 1, default: 8 },
      { prop: 'turbulence', label: 'Turbulence', type: 'slider', min: 0, max: 10, step: 0.5, default: 0 },
      { prop: 'brightness', label: 'Brightness', type: 'slider', min: 10, max: 100, step: 5, default: 100 },
      { prop: 'glitterIntensity', label: 'Glitter', type: 'slider', min: 0, max: 10, step: 0.5, default: 3 },
      { prop: 'trailAmount', label: 'Trail', type: 'slider', min: 0, max: 100, step: 5, default: 0 },
      { prop: 'reverse', label: 'Reverse', type: 'toggle', default: false },
    ]
  },
  chromaticWaves: {
    name: 'Chromatic Waves',
    renderer: 'webgl2',
    componentFile: 'ChromaticWaves.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'frequency', label: 'Frequency', type: 'slider', min: 1, max: 10, step: 0.5, default: 1 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.5, max: 20, step: 0.5, default: 4 },
      { prop: 'bgColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#FFFFFF', '#FFFFFF', '#FFFFFF'] },
      { prop: 'cellSize', label: 'Cell Size', type: 'slider', min: 1, max: 100, step: 1, default: 34 },
      { prop: 'gamma', label: 'Gamma', type: 'slider', min: 1, max: 20, step: 1, default: 6 },
      { prop: 'paletteBias', label: 'Exposure', type: 'slider', min: -10, max: 10, step: 1, default: -3 },
    ]
  },
  dotMatrix: {
    name: 'Dot Matrix',
    renderer: 'webgl2',
    componentFile: 'DotMatrix.tsx',
    palette: ['#ffffff', '#e07000', '#000000'],
    controls: [
      { prop: 'frequency', label: 'Frequency', type: 'slider', min: 1, max: 10, step: 0.5, default: 1 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.5, max: 20, step: 0.5, default: 6 },
      { prop: 'bgColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#FFFFFF', '#E07000', '#000000'] },
      { prop: 'cellSize', label: 'Cell Size', type: 'slider', min: 1, max: 100, step: 1, default: 20 },
      { prop: 'gamma', label: 'Gamma', type: 'slider', min: 1, max: 20, step: 1, default: 4 },
      { prop: 'paletteBias', label: 'Exposure', type: 'slider', min: -10, max: 10, step: 1, default: 10 },
      { prop: 'useGlyphAtlas', label: 'Glyphs', type: 'toggle', default: false },
      { prop: 'characters', label: 'Characters', type: 'text', maxLength: 32, default: '●○•·' },
      { prop: 'fontFamily', label: 'Font', type: 'select', options: ['monospace', 'sans-serif', 'serif'], default: 'monospace' },
      { prop: 'fontWeight', label: 'Font Weight', type: 'slider', min: 100, max: 900, step: 100, default: 400 },
      { prop: 'fontSizePx', label: 'Glyph Size', type: 'slider', min: 16, max: 96, step: 2, default: 42 },
    ]
  },
  pixelTetris: {
    name: 'Pixel Tetris',
    renderer: 'canvas2d',
    componentFile: 'PixelTetris.tsx',
    palette: ['#f9731a', '#ffffff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'colors', label: 'Block Colors', type: 'colorArray', count: 2, default: ['#F9731A', '#FFFFFF'] },
      { prop: 'movement', label: 'Movement', type: 'slider', min: 0, max: 10, step: 0.5, default: 4 },
      { prop: 'cellSize', label: 'Cell Size', type: 'slider', min: 10, max: 48, step: 1, default: 29 },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 0, max: 6, step: 1, default: 1 },
      { prop: 'rounded', label: 'Roundness', type: 'slider', min: 0, max: 20, step: 1, default: 20 },
      { prop: 'dropSpeed', label: 'Drop Speed', type: 'slider', min: 0.5, max: 6, step: 0.25, default: 2 },
    ]
  },
  risingLines: {
    name: 'Rising Lines',
    renderer: 'canvas2d',
    componentFile: 'RisingLines.tsx',
    palette: ['#ffffff', '#c918f8', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'particles', label: 'Sparks', type: 'slider', min: 50, max: 1500, step: 50, default: 500 },
      { prop: 'color', label: 'Spark Color', type: 'color', default: '#FFFFFF' },
      { prop: 'riseSpeed', label: 'Rise Speed', type: 'slider', min: 0, max: 60, step: 1, default: 25 },
      { prop: 'opacity', label: 'Opacity', type: 'slider', min: 10, max: 100, step: 5, default: 100 },
      { prop: 'scale', label: 'Scale', type: 'slider', min: 1, max: 12, step: 0.5, default: 7 },
      { prop: 'direction', label: 'Direction', type: 'select', options: ['up', 'down'], default: 'up' },
      { prop: 'showHorizon', label: 'Horizon', type: 'toggle', default: true },
      { prop: 'horizonColor', label: 'Horizon Color', type: 'color', default: '#C918F8' },
      { prop: 'horizonOpacity', label: 'Horizon Opacity', type: 'slider', min: 0, max: 100, step: 5, default: 85 },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
    ]
  },
  starBurst: {
    name: 'Star Burst',
    renderer: 'canvas2d',
    componentFile: 'StarBurst.tsx',
    palette: ['#ffffff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 1, max: 40, step: 1, default: 10 },
      { prop: 'starCount', label: 'Rays', type: 'slider', min: 20, max: 180, step: 5, default: 100 },
      { prop: 'color', label: 'Color', type: 'color', default: '#FFFFFF' },
      { prop: 'centerX', label: 'Center X', type: 'slider', min: 0, max: 100, step: 5, default: 50 },
      { prop: 'centerY', label: 'Center Y', type: 'slider', min: 0, max: 100, step: 5, default: 100 },
      { prop: 'starSize', label: 'Streak Size', type: 'slider', min: 2, max: 40, step: 1, default: 12 },
      { prop: 'opacity', label: 'Opacity', type: 'slider', min: 5, max: 100, step: 5, default: 50 },
      { prop: 'flowerIntensity', label: 'Core Glow', type: 'slider', min: 0, max: 40, step: 1, default: 10 },
      { prop: 'twinkleSpeed', label: 'Twinkle Speed', type: 'slider', min: 0, max: 20, step: 1, default: 4 },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
    ]
  },
  particleTunnel: {
    name: 'Particle Tunnel',
    renderer: 'canvas2d',
    componentFile: 'ParticleTunnel.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'x', label: 'Center X', type: 'slider', min: 0, max: 100, step: 5, default: 50 },
      { prop: 'y', label: 'Center Y', type: 'slider', min: 0, max: 100, step: 5, default: 50 },
      { prop: 'radius', label: 'Void Radius', type: 'slider', min: 0, max: 60, step: 2, default: 10 },
      { prop: 'density', label: 'Spokes', type: 'slider', min: 4, max: 60, step: 2, default: 30 },
      { prop: 'gap', label: 'Depth Gap', type: 'slider', min: 20, max: 160, step: 5, default: 40 },
      { prop: 'particleSize', label: 'Particle Size', type: 'slider', min: 1, max: 12, step: 0.5, default: 4 },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffffff', '#ffffff', '#ffffff'] },
      { prop: 'direction', label: 'Direction', type: 'select', options: ['inside', 'outside'], default: 'inside' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 0.5, max: 12, step: 0.5, default: 2 },
      { prop: 'voidColor', label: 'Void Color', type: 'color', default: '#000000' },
    ]
  },
  floatingIcons: {
    name: 'Floating Icons',
    renderer: 'canvas2d',
    componentFile: 'FloatingIcons.tsx',
    palette: ['#dd2e44', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'text', label: 'Glyphs', type: 'text', maxLength: 32, default: '❤️' },
      { prop: 'direction', label: 'Direction', type: 'select', options: ['top', 'bottom'], default: 'bottom' },
      { prop: 'amount', label: 'Count', type: 'slider', min: 5, max: 80, step: 1, default: 30 },
      { prop: 'minSpeed', label: 'Min Speed', type: 'slider', min: 1, max: 50, step: 1, default: 20 },
      { prop: 'maxSpeed', label: 'Max Speed', type: 'slider', min: 1, max: 50, step: 1, default: 23 },
      { prop: 'minShake', label: 'Min Sway', type: 'slider', min: 0, max: 100, step: 2, default: 32 },
      { prop: 'maxShake', label: 'Max Sway', type: 'slider', min: 0, max: 100, step: 2, default: 0 },
      { prop: 'coverage', label: 'Coverage', type: 'slider', min: 20, max: 150, step: 5, default: 100 },
      { prop: 'minSize', label: 'Min Size', type: 'slider', min: 2, max: 40, step: 1, default: 4 },
      { prop: 'maxSize', label: 'Max Size', type: 'slider', min: 8, max: 80, step: 2, default: 54 },
    ]
  },
  snakeGrid: {
    name: 'Snake Grid',
    renderer: 'canvas2d',
    componentFile: 'SnakeGrid.tsx',
    palette: ['#ffffff', '#f9731a', '#000000'],
    controls: [
      { prop: 'snakeColor', label: 'Snake Color', type: 'color', default: '#FFFFFF' },
      { prop: 'foodColor', label: 'Food Color', type: 'color', default: '#F9731A' },
      { prop: 'cellSize', label: 'Cell Size', type: 'slider', min: 16, max: 56, step: 2, default: 42 },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 0, max: 6, step: 1, default: 1 },
      { prop: 'rounded', label: 'Roundness', type: 'slider', min: 0, max: 20, step: 1, default: 0 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 2, max: 24, step: 1, default: 10 },
      { prop: 'startLength', label: 'Start Length', type: 'slider', min: 1, max: 12, step: 1, default: 1 },
      { prop: 'growth', label: 'Growth', type: 'slider', min: 1, max: 6, step: 1, default: 1 },
      { prop: 'fade', label: 'Tail Fade', type: 'slider', min: 0, max: 100, step: 2, default: 32 },
    ]
  },
  gridHole: {
    name: 'Grid Hole',
    renderer: 'canvas2d',
    componentFile: 'GridHole.tsx',
    palette: ['#ffffff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'speed', label: 'Speed', type: 'slider', min: 10, max: 150, step: 5, default: 50 },
      { prop: 'strokeColor', label: 'Line Color', type: 'color', default: '#FFFFFF' },
      { prop: 'lineWidth', label: 'Line Width', type: 'slider', min: 0.5, max: 5, step: 0.25, default: 1 },
      { prop: 'lines', label: 'Lines', type: 'slider', min: 8, max: 120, step: 4, default: 80 },
      { prop: 'discs', label: 'Rings', type: 'slider', min: 10, max: 120, step: 5, default: 80 },
      { prop: 'particles', label: 'Particles', type: 'toggle', default: true },
      { prop: 'particleColor', label: 'Particle Color', type: 'color', default: '#FFFFFF' },
      { prop: 'particleCount', label: 'Particle Count', type: 'slider', min: 50, max: 500, step: 10, default: 300 },
      { prop: 'glow', label: 'Core Glow', type: 'toggle', default: true },
      { prop: 'glowColor', label: 'Glow Color', type: 'color', default: '#FFFFFF' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
    ]
  },
  waveArcs: {
    name: 'Wave Arcs',
    renderer: 'canvas2d',
    componentFile: 'WaveArcs.tsx',
    palette: ['#ffffff', '#0a0a0a'],
    controls: [
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#0A0A0A' },
      { prop: 'lineColor', label: 'Line Color', type: 'color', default: '#ffffff' },
      { prop: 'lineWidth', label: 'Line Width', type: 'slider', min: 0.5, max: 5, step: 0.25, default: 1.5 },
      { prop: 'lineCount', label: 'Arc Count', type: 'slider', min: 12, max: 100, step: 4, default: 76 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 1, max: 30, step: 1, default: 6 },
      // Below 4 the fan is two or three arcs on a 190px card and nothing at all
      // in the 73-113px picker tile. WaveArcs.tsx used to floor the value by
      // container height instead, which made one saved number mean three
      // different pictures across the card, the preview and the picker.
      { prop: 'glow', label: 'Glow', type: 'slider', min: 4, max: 50, step: 1, default: 10 },
      { prop: 'interactive', label: 'Follow Pointer', type: 'toggle', default: true },
    ]
  },
  reactiveGrid: {
    name: 'Reactive Grid',
    renderer: 'canvas2d',
    componentFile: 'ReactiveGrid.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'shape', label: 'Shape', type: 'select', options: ['square', 'rounded', 'circle', 'triangle', 'diamond', 'hexagon', 'star'], default: 'rounded' },
      { prop: 'fill', label: 'Fill', type: 'select', options: ['solid', 'stroke'], default: 'solid' },
      { prop: 'strokeWidth', label: 'Stroke Width', type: 'slider', min: 0.5, max: 6, step: 0.25, default: 1.5 },
      { prop: 'particleColor', label: 'Color', type: 'color', default: '#FFFFFF' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'maxSize', label: 'Max Size', type: 'slider', min: 16, max: 64, step: 2, default: 36 },
      // Not 0. With Autoplay off nothing ever swells a cell unless a real
      // pointer is on the card — never, on a phone — so every cell sits at Min
      // Size for good, and at 0 the component draws none of them: a flat
      // rectangle of Background over the operator's gradient, composed from two
      // ordinary controls with nothing to say the card had gone blank. The
      // component floors the same number for records that predate this.
      { prop: 'minSize', label: 'Min Size', type: 'slider', min: 2, max: 30, step: 1, default: 12 },
      { prop: 'gap', label: 'Gap', type: 'slider', min: 0, max: 24, step: 1, default: 4 },
      { prop: 'influence', label: 'Influence', type: 'slider', min: 40, max: 400, step: 10, default: 120 },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  reactiveLines: {
    name: 'Reactive Lines',
    renderer: 'canvas2d',
    componentFile: 'ReactiveLines.tsx',
    palette: ['#ffffff', '#0a0a0a'],
    controls: [
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#0a0a0a' },
      { prop: 'lineColor', label: 'Line Color', type: 'color', default: '#ffffff' },
      { prop: 'lineWidth', label: 'Line Width', type: 'slider', min: 0.5, max: 6, step: 0.25, default: 1 },
      { prop: 'minLines', label: 'Min Lines', type: 'slider', min: 1, max: 40, step: 1, default: 2 },
      { prop: 'maxLines', label: 'Max Lines', type: 'slider', min: 5, max: 70, step: 1, default: 45 },
      { prop: 'fade', label: 'Vignette', type: 'toggle', default: false },
      { prop: 'fadeIntensity', label: 'Vignette Strength', type: 'slider', min: 1, max: 50, step: 1, default: 15 },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  prismGrid: {
    name: 'Prism Grid',
    renderer: 'canvas2d',
    componentFile: 'PrismGrid.tsx',
    palette: ['#ffffff', '#ffc2e3', '#deffea', '#dfc2ff', '#000000'],
    controls: [
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'boxSize', label: 'Cell Size', type: 'slider', min: 28, max: 90, step: 2, default: 40 },
      { prop: 'borderWidth', label: 'Border Width', type: 'slider', min: 0, max: 5, step: 0.25, default: 2 },
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 6, default: ['#FFFFFF', '#FFC2E3', '#DEFFEA', '#A68F1F', '#A85E5E', '#DFC2FF'] },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  thunderstrike: {
    name: 'Thunderstrike',
    renderer: 'webgl1',
    componentFile: 'Thunderstrike.tsx',
    palette: ['#593c0c', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'lightningColor', label: 'Bolt Color', type: 'color', default: '#593C0C' },
      { prop: 'backgroundColor', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'xOffset', label: 'Offset X', type: 'slider', min: -30, max: 30, step: 1, default: 11 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 10, max: 110, step: 1, default: 55 },
      { prop: 'intensity', label: 'Intensity', type: 'slider', min: 20, max: 120, step: 1, default: 69 },
      { prop: 'size', label: 'Detail', type: 'slider', min: 5, max: 60, step: 1, default: 20 },
      { prop: 'angle', label: 'Angle', type: 'slider', min: -90, max: 90, step: 5, default: 10 },
    ]
  },
  blackhole: {
    name: 'Black Hole',
    renderer: 'canvas2d',
    componentFile: 'Blackhole.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'colors', label: 'Colors', type: 'colorArray', count: 3, default: ['#ffffff', '#ffffff', '#ffffff'] },
      { prop: 'background', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'particleCount', label: 'Particles', type: 'slider', min: 60, max: 600, step: 20, default: 260 },
      { prop: 'particleSize', label: 'Particle Size', type: 'slider', min: 1, max: 50, step: 1, default: 4 },
      { prop: 'orbitSpeed', label: 'Orbit Speed', type: 'slider', min: 0.5, max: 15, step: 0.5, default: 4 },
      { prop: 'trail', label: 'Trail Length', type: 'slider', min: 0, max: 50, step: 1, default: 50 },
      { prop: 'tilt', label: 'Tilt', type: 'slider', min: -90, max: 90, step: 5, default: 20 },
      { prop: 'showCenter', label: 'Event Horizon', type: 'toggle', default: true },
      { prop: 'voidRadius', label: 'Core Size', type: 'slider', min: 10, max: 100, step: 5, default: 40 },
      { prop: 'outerRadius', label: 'Disk Radius', type: 'slider', min: 20, max: 100, step: 2, default: 70 },
      { prop: 'pullSpeed', label: 'Infall', type: 'slider', min: 0, max: 20, step: 0.5, default: 0 },
    ]
  },
  cosmicOrb: {
    name: 'Cosmic Orb',
    renderer: 'webgl1',
    componentFile: 'CosmicOrb.tsx',
    palette: ['#6a3cff', '#3ce0ff', '#a24bff', '#ff5ea8', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'fit', label: 'Fit', type: 'select', options: ['cover', 'contain'], default: 'cover' },
      { prop: 'zoom', label: 'Zoom', type: 'slider', min: 0.5, max: 3, step: 0.05, default: 1 },
      { prop: 'archetype', label: 'Galaxy Type', type: 'select', options: ['auto', 'spiral', 'nebula', 'core', 'deep'], default: 'auto' },
      { prop: 'anchor', label: 'Anchor Color', type: 'color', default: '#6A3CFF' },
      { prop: 'colorA', label: 'Color A', type: 'color', default: '#3CE0FF' },
      { prop: 'colorB', label: 'Color B', type: 'color', default: '#A24BFF' },
      { prop: 'colorC', label: 'Color C', type: 'color', default: '#FF5EA8' },
      { prop: 'background', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 5, max: 150, step: 5, default: 50 },
      { prop: 'spin', label: 'Spin', type: 'slider', min: 0, max: 150, step: 5, default: 50 },
      { prop: 'lens', label: 'Lens Warp', type: 'toggle', default: true },
      { prop: 'lensAmount', label: 'Lens Strength', type: 'slider', min: 0, max: 100, step: 5, default: 45 },
      // The one off-grid default fixed by moving the DEFAULT rather than the
      // step: this seed only has to differ from other seeds, so its fractional
      // part bought nothing and cost the operator a value they could never get
      // back once they had nudged the slider. `CosmicOrb.tsx` carries the same
      // number as its own default.
      { prop: 'seed', label: 'Variant', type: 'slider', min: 0, max: 100, step: 1, default: 17 },
    ]
  },
  tornado: {
    name: 'Tornado',
    renderer: 'webgl2',
    componentFile: 'Tornado.tsx',
    palette: ['#ffffff', '#f9731a', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'background', label: 'Background', type: 'color', default: '#000000' },
      { prop: 'lineCount', label: 'Strands', type: 'slider', min: 20, max: 200, step: 5, default: 120 },
      { prop: 'lineColor', label: 'Strand Color', type: 'color', default: '#ffffff' },
      { prop: 'lineGlow', label: 'Strand Glow', type: 'slider', min: 0, max: 10, step: 0.25, default: 10 },
      { prop: 'twist', label: 'Twist', type: 'slider', min: 0, max: 10, step: 0.25, default: 3 },
      { prop: 'zoom', label: 'Zoom', type: 'slider', min: 40, max: 110, step: 1, default: 75 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 2, max: 40, step: 1, default: 10 },
      { prop: 'direction', label: 'Direction', type: 'select', options: ['right', 'left'], default: 'right' },
      { prop: 'dots', label: 'Dots', type: 'toggle', default: true },
      { prop: 'dotCount', label: 'Dot Count', type: 'slider', min: 250, max: 3000, step: 50, default: 2000 },
      { prop: 'dotColor', label: 'Dot Color', type: 'color', default: '#ffffff' },
      { prop: 'comets', label: 'Comets', type: 'toggle', default: true },
      { prop: 'cometColor', label: 'Comet Color', type: 'color', default: '#F9731A' },
      { prop: 'repel', label: 'Cursor Repel', type: 'toggle', default: false },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
  cube: {
    name: 'Cube',
    renderer: 'canvas2d',
    componentFile: 'Cube.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { prop: 'cubeGrid', label: 'Layers', type: 'slider', min: 2, max: 5, step: 1, default: 3 },
      { prop: 'dotsPerFace', label: 'Dot Density', type: 'slider', min: 2, max: 5, step: 1, default: 5 },
      { prop: 'dotSize', label: 'Dot Size', type: 'slider', min: 1, max: 6, step: 0.25, default: 2 },
      { prop: 'rotationX', label: 'Tumble X', type: 'slider', min: -12, max: 12, step: 0.5, default: 0 },
      { prop: 'rotationY', label: 'Tumble Y', type: 'slider', min: -12, max: 12, step: 0.5, default: 11 },
      { prop: 'rotationZ', label: 'Tumble Z', type: 'slider', min: -12, max: 12, step: 0.5, default: 0 },
      { prop: 'sizePercent', label: 'Size', type: 'slider', min: 20, max: 200, step: 5, default: 100 },
    ]
  },
  wordGlobe: {
    name: 'Word Globe',
    renderer: 'canvas2d',
    componentFile: 'WordGlobe.tsx',
    palette: ['#ffffff', '#000000'],
    controls: [
      { prop: 'word', label: 'Word', type: 'text', maxLength: 24, default: 'dream' },
      { prop: 'color', label: 'Color', type: 'color', default: '#ffffff' },
      { prop: 'fontSize', label: 'Font Size', type: 'slider', min: 8, max: 40, step: 1, default: 15 },
      { prop: 'fontWeight', label: 'Font Weight', type: 'slider', min: 100, max: 900, step: 100, default: 500 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 1, max: 30, step: 0.5, default: 7 },
      { prop: 'rotationSide', label: 'Direction', type: 'select', options: ['clockwise', 'counterclockwise'], default: 'counterclockwise' },
      { prop: 'twist', label: 'Twist', type: 'slider', min: 0, max: 100, step: 5, default: 50 },
      { prop: 'letterSpacing', label: 'Letter Spacing', type: 'slider', min: 200, max: 2000, step: 50, default: 800 },
    ]
  },
  particleSphere: {
    name: 'Particle Sphere',
    renderer: 'webgl2',
    componentFile: 'Particlesphere.tsx',
    palette: ['#ffffff', '#000000'],
    fullOutputGamut: true,
    controls: [
      { prop: 'sphereColor', label: 'Color', type: 'color', default: '#FFFFFF' },
      { prop: 'particlesCount', label: 'Particles', type: 'slider', min: 500, max: 4000, step: 100, default: 2500 },
      { prop: 'particleScale', label: 'Particle Size', type: 'slider', min: 1, max: 10, step: 0.5, default: 8 },
      { prop: 'scale', label: 'Sphere Size', type: 'slider', min: 2, max: 10, step: 0.5, default: 10 },
      { prop: 'speed', label: 'Speed', type: 'slider', min: 5, max: 60, step: 1, default: 20 },
      { prop: 'rotationDirection', label: 'Direction', type: 'select', options: ['clockwise', 'anticlockwise'], default: 'clockwise' },
      { prop: 'cursorOn', label: 'Cursor Push', type: 'toggle', default: true },
      { prop: 'cursorRadius', label: 'Cursor Radius', type: 'slider', min: 20, max: 200, step: 5, default: 75 },
      { prop: 'cursorStrength', label: 'Cursor Strength', type: 'slider', min: 0, max: 10, step: 0.5, default: 10 },
      { prop: 'autoplay', label: 'Autoplay', type: 'toggle', default: true },
    ]
  },
} satisfies Record<string, CardEffectEntry>

/** Every effect the panel can offer. `'NONE'` is the absence of one, not a member. */
export type CardEffectId = keyof typeof CARD_EFFECT_CATALOG

const ENTRIES: Readonly<Record<string, CardEffectEntry>> = CARD_EFFECT_CATALOG

export interface CardEffectDef extends CardEffectEntry {
  id: CardEffectId
}

/**
 * The catalog as an ordered list, which is how the effect grid renders it.
 *
 * Object key order is insertion order for non-numeric keys, so the grid keeps
 * the sequence written above without a second array to maintain.
 */
export const CARD_EFFECT_REGISTRY: readonly CardEffectDef[] = Object.entries(
  CARD_EFFECT_CATALOG,
).map(([id, entry]) => ({ id: id as CardEffectId, ...entry }))

/**
 * Whether the panel actually has `id`.
 *
 * `Object.hasOwn` rather than `in`, and load-bearing rather than stylistic:
 * `'toString' in CARD_EFFECT_CATALOG` is `true`, and the lookup after it would
 * return an inherited function where an effect was expected.
 */
export function isKnownCardEffect(id: string): id is CardEffectId {
  return Object.hasOwn(ENTRIES, id)
}

export function getCardEffectDef(id: string): CardEffectDef | undefined {
  return isKnownCardEffect(id) ? { id, ...ENTRIES[id] } : undefined
}

/** Default props for `id`, taken from its controls so the two cannot disagree. */
export function getCardEffectDefaults(id: string): Record<string, unknown> {
  const entry = isKnownCardEffect(id) ? ENTRIES[id] : undefined
  if (!entry) return {}
  const props: Record<string, unknown> = {}
  for (const control of entry.controls) props[control.prop] = control.default
  return props
}

export function cardEffectRenderer(id: string): CardEffectRenderer | null {
  return isKnownCardEffect(id) ? ENTRIES[id].renderer : null
}

export function cardEffectPalette(id: string): readonly string[] {
  return isKnownCardEffect(id) ? ENTRIES[id].palette : CARD_EFFECT_CATALOG.aurora.palette
}

export function hasFullOutputGamut(id: string): boolean {
  return isKnownCardEffect(id) && ENTRIES[id].fullOutputGamut === true
}
